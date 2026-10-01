import { Cause, Effect, Exit } from "effect";
import { z } from "zod";
import type { components } from "./generated/api";

const errorEnvelope = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    requestId: z.string(),
  }),
});

/** Decode only the public error envelope; malformed/proxy errors retain a safe fallback. */
export async function readApiError(
  response: Response,
  fallback = "Request could not be completed.",
): Promise<components["schemas"]["Error"]["error"]> {
  const body: unknown = await response.json().catch(() => undefined);
  const decoded = errorEnvelope.safeParse(body);
  if (decoded.success) return decoded.data.error;
  return {
    code: "http_error",
    message: fallback,
    requestId: response.headers.get("X-Request-ID") ?? "",
  };
}

export type Authentication =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "cookie" };

export type ClientConfiguration = {
  serverBaseUrl: string;
  authentication: Authentication;
};

export const authenticationRequiredEvent = "videocutlist:authentication-required";

export const MAX_INTERCHANGE_FILE_BYTES = 1 << 20;
export const validInterchangeFileSize = (size: number) =>
  Number.isSafeInteger(size) && size >= 0 && size <= MAX_INTERCHANGE_FILE_BYTES;

declare global {
  interface Window {
    VIDEOCUTLIST_CONFIG?: ClientConfiguration;
  }
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const hasControlCharacter = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

function apiBase(serverBaseUrl: string) {
  let base: URL;
  try {
    base = new URL(serverBaseUrl);
  } catch {
    throw new Error("serverBaseUrl must be an absolute HTTP(S) URL.");
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("serverBaseUrl must not contain credentials, a query, or a fragment.");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/api/v1/`;
  return base;
}

function validateAuthentication(authentication: Authentication) {
  if (!authentication || typeof authentication !== "object")
    throw new Error("authentication is required.");
  if (authentication.type === "none" || authentication.type === "cookie") return authentication;
  if (
    authentication.type === "bearer" &&
    typeof authentication.token === "string" &&
    authentication.token.length > 0 &&
    !hasControlCharacter(authentication.token)
  )
    return authentication;
  throw new Error("Invalid authentication configuration.");
}

export function resolveBrowserConfiguration(browser: Window = window): ClientConfiguration {
  const configuration = browser.VIDEOCUTLIST_CONFIG ?? {
    serverBaseUrl: browser.location.origin,
    authentication: { type: "none" as const },
  };
  apiBase(configuration.serverBaseUrl);
  validateAuthentication(configuration.authentication);
  browser.VIDEOCUTLIST_CONFIG = configuration;
  return configuration;
}

export interface ApiClient {
  url(relativePath: string): string;
  request(relativePath: string, init?: RequestInit): Promise<Response>;
  assetRequest(
    mediaId: string,
    kind: "thumbnails" | "waveform",
    params: Record<string, number>,
    init?: RequestInit,
  ): Promise<Response>;
}

export interface StreamingApiClient extends ApiClient {
  reportUnauthorized(
    status: number | undefined,
    authentication: Authentication,
    signal?: AbortSignal | null,
  ): void;
}

export function createApiClient(
  configuration: ClientConfiguration,
  fetchImplementation: Fetch = fetch,
): StreamingApiClient {
  const base = apiBase(configuration.serverBaseUrl);
  validateAuthentication(configuration.authentication);

  const url = (relativePath: string) => {
    if (
      typeof relativePath !== "string" ||
      relativePath.startsWith("/") ||
      relativePath.startsWith("//") ||
      /^[a-z][a-z\d+.-]*:/i.test(relativePath) ||
      relativePath.includes("#") ||
      relativePath.includes("\\")
    )
      throw new Error("API paths must be relative and remain within /api/v1/.");
    const path = relativePath.split("?", 1)[0];
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      throw new Error("API paths must use valid percent encoding.");
    }
    if (decodedPath.split(/[\\/]/).some((segment) => segment === "." || segment === ".."))
      throw new Error("API paths must not contain parent-escaping segments.");
    const target = new URL(relativePath, base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname))
      throw new Error("API paths must remain within /api/v1/.");
    return target.toString();
  };

  const reportUnauthorized = (
    status: number | undefined,
    authentication: Authentication,
    signal?: AbortSignal | null,
  ) => {
    if (
      status === 401 &&
      configuration.authentication === authentication &&
      !signal?.aborted &&
      typeof window !== "undefined"
    )
      window.dispatchEvent(new Event(authenticationRequiredEvent));
  };

  const request = (relativePath: string, init: RequestInit = {}) => {
    const authentication = validateAuthentication(configuration.authentication);
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    const credentials = authentication.type === "cookie" ? "include" : "omit";
    if (authentication.type === "bearer")
      headers.set("Authorization", `Bearer ${authentication.token}`);
    return fetchImplementation(url(relativePath), {
      ...init,
      credentials,
      headers,
    }).then((response) => {
      reportUnauthorized(response.status, authentication, init.signal);
      return response;
    });
  };

  const assetRequest = (
    mediaId: string,
    kind: "thumbnails" | "waveform",
    params: Record<string, number>,
    init: RequestInit = {},
  ) => {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    );
    return request(`media/${encodeURIComponent(mediaId)}/${kind}?${query}`, init);
  };
  return { url, request, assetRequest, reportUnauthorized };
}

/** Public server failures retain their stable code and correlation ID. */
export class ApiFailure extends Error {
  readonly _tag = "ApiFailure";
  readonly code: string;
  readonly requestId: string;

  constructor(
    readonly status: number,
    error: components["schemas"]["Error"]["error"],
  ) {
    super(error.message);
    this.name = "ApiFailure";
    this.code = error.code;
    this.requestId = error.requestId;
  }
}

/** The fiber's lifetime reaches fetch, including callers' explicit cancellation. */
export function apiRequest(
  api: ApiClient,
  path: string,
  init: RequestInit = {},
): Effect.Effect<Response, Error> {
  return Effect.tryPromise({
    try: (signal) =>
      api.request(path, {
        ...init,
        signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Request could not be completed."),
  });
}

/** Keep fetch and body consumption in the same interruptible operation. */
export function apiJson<A>(
  api: ApiClient,
  path: string,
  init: RequestInit = {},
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await api.request(path, {
        ...init,
        signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
      if (!response.ok) throw new ApiFailure(response.status, await readApiError(response));
      return (await response.json()) as A;
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Request could not be completed."),
  });
}

/** Promise consumers receive the original public failure, never a FiberFailure string. */
export async function runEffect<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
