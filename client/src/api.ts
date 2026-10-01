import { Cause, Effect, Exit, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";
import type { components } from "./generated/api";
import { Error as ApiErrorSchema } from "./generated/effect-api";

/** Decode only the public error envelope; malformed/proxy errors retain a safe fallback. */
export async function readApiError(
  response: Response,
  fallback = "Request could not be completed.",
): Promise<components["schemas"]["Error"]["error"]> {
  const body: unknown = await response.json().catch(() => undefined);
  try {
    return Schema.decodeUnknownSync(ApiErrorSchema)(body).error;
  } catch {
    // Malformed/proxy errors retain a safe fallback.
  }
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

function resolveRelativeUrl(base: URL, relativePath: string, root: string) {
  if (
    typeof relativePath !== "string" ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(relativePath) ||
    relativePath.includes("#") ||
    relativePath.includes("\\")
  )
    throw new Error(`Paths must be relative and remain within ${root}.`);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(relativePath.split("?", 1)[0]);
  } catch {
    throw new Error("Paths must use valid percent encoding.");
  }
  if (decodedPath.split(/[\\/]/).some((segment) => segment === "." || segment === ".."))
    throw new Error("Paths must not contain parent-escaping segments.");
  const target = new URL(relativePath, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname))
    throw new Error(`Paths must remain within ${root}.`);
  return target;
}

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
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/api/v2/`;
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
): StreamingApiClient & { mediaUrl(relativePath: string): string } {
  const base = apiBase(configuration.serverBaseUrl);
  validateAuthentication(configuration.authentication);

  const url = (relativePath: string) =>
    resolveRelativeUrl(base, relativePath, "/api/v2/").toString();

  const mediaBase = new URL(base);
  mediaBase.pathname = `${base.pathname.replace(/\/api\/v2\/$/, "")}/media/v2/`;

  const mediaUrl = (relativePath: string) => {
    const target = resolveRelativeUrl(mediaBase, relativePath, "/media/v2/");
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
    const authentication = validateAuthentication(configuration.authentication);
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    if (authentication.type === "bearer")
      headers.set("Authorization", `Bearer ${authentication.token}`);
    return fetchImplementation(mediaUrl(`${encodeURIComponent(mediaId)}/${kind}?${query}`), {
      ...init,
      credentials: authentication.type === "cookie" ? "include" : "omit",
      headers,
    }).then((response) => {
      reportUnauthorized(response.status, authentication, init.signal);
      return response;
    });
  };
  return { url, mediaUrl, request, assetRequest, reportUnauthorized };
}

/** FetchHttpClient policy for generated JSON and native HTTP requests. */
export function createNativeHttpClientLayer(
  configuration: ClientConfiguration,
  fetchImplementation: Fetch = fetch,
): Layer.Layer<HttpClient.HttpClient> {
  const api = createApiClient(configuration, fetchImplementation);
  const base = new URL(api.url(""));
  const mediaBase = new URL(api.mediaUrl(""));
  const authorizedFetch: typeof fetch = (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    const parsed = new URL(target);
    if (parsed.hash) throw new Error("HTTP requests must not contain URL fragments.");
    const root = parsed.pathname.startsWith(base.pathname) ? base : mediaBase;
    resolveRelativeUrl(
      root,
      `${parsed.pathname.slice(root.pathname.length)}${parsed.search}`,
      root.pathname,
    );
    const authentication = validateAuthentication(configuration.authentication);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.delete("Authorization");
    if (authentication.type === "bearer")
      headers.set("Authorization", `Bearer ${authentication.token}`);
    const credentials = authentication.type === "cookie" ? "include" : "omit";
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetchImplementation(input, { ...init, credentials, headers }).then((response) => {
      api.reportUnauthorized(response.status, authentication, signal);
      return response;
    });
  };
  return FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, authorizedFetch)),
  );
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
