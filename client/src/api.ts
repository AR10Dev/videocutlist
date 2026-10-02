import type * as EffectApiTypes from "./generated/effect-api";
import { Cause, Effect, Exit, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";
import { Error as ApiErrorSchema } from "./generated/effect-api";

/** Decode only the public error envelope; malformed/proxy errors retain a safe fallback. */
export async function readApiError(
  response: Response,
  fallback = "Request could not be completed.",
): Promise<EffectApiTypes.Error["error"]> {
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

function authenticatedFetch(
  configuration: ClientConfiguration,
  fetchImplementation: Fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  reportUnauthorized: StreamingApiClient["reportUnauthorized"],
  redirect?: RequestRedirect,
) {
  const authentication = validateAuthentication(configuration.authentication);
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  headers.delete("Authorization");
  if (authentication.type === "bearer")
    headers.set("Authorization", `Bearer ${authentication.token}`);
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  return fetchImplementation(input, {
    ...init,
    credentials: authentication.type === "cookie" ? "include" : "omit",
    headers,
    ...(redirect ? { redirect } : {}),
  }).then((response) => {
    reportUnauthorized(response.status, authentication, signal);
    return response;
  });
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

export interface NativeMediaApiClient extends StreamingApiClient {
  mediaRequest(relativePath: string, init?: RequestInit): Promise<Response>;
}

export function createApiClient(
  configuration: ClientConfiguration,
  fetchImplementation: Fetch = fetch,
): NativeMediaApiClient & { mediaUrl(relativePath: string): string } {
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

  const request = (relativePath: string, init: RequestInit = {}) =>
    authenticatedFetch(
      configuration,
      fetchImplementation,
      url(relativePath),
      init,
      reportUnauthorized,
    );

  const mediaRequest = (relativePath: string, init: RequestInit = {}) =>
    authenticatedFetch(
      configuration,
      fetchImplementation,
      mediaUrl(relativePath),
      init,
      reportUnauthorized,
      "error",
    );

  const assetRequest = (
    mediaId: string,
    kind: "thumbnails" | "waveform",
    params: Record<string, number>,
    init: RequestInit = {},
  ) => {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    );
    return authenticatedFetch(
      configuration,
      fetchImplementation,
      mediaUrl(`media/${encodeURIComponent(mediaId)}/${kind}?${query}`),
      init,
      reportUnauthorized,
      "error",
    );
  };
  return { url, mediaUrl, request, mediaRequest, assetRequest, reportUnauthorized };
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
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (typeof rawUrl !== "string" || hasControlCharacter(rawUrl))
      throw new Error("HTTP requests must use a safe absolute URL.");
    const schemeEnd = rawUrl.indexOf("://");
    if (schemeEnd < 1) throw new Error("HTTP requests must use an absolute URL.");
    const afterAuthority = rawUrl.slice(schemeEnd + 3);
    const pathStart = afterAuthority.search(/[/?#]/);
    const rawPath =
      pathStart < 0 || afterAuthority[pathStart] !== "/"
        ? "/"
        : afterAuthority.slice(pathStart).split(/[?#]/, 1)[0];
    let decodedRawPath: string;
    try {
      decodedRawPath = decodeURIComponent(rawPath);
    } catch {
      throw new Error("HTTP request paths must use valid percent encoding.");
    }
    if (
      hasControlCharacter(decodedRawPath) ||
      decodedRawPath.split(/[\\/]/).some((segment) => segment === "." || segment === "..")
    )
      throw new Error("HTTP request paths must not contain control or traversal segments.");
    const target = new URL(rawUrl);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.origin !== base.origin ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new Error("HTTP requests must remain on the configured origin.");
    const root = [base, mediaBase].find((candidate) =>
      target.pathname.startsWith(candidate.pathname),
    );
    if (!root)
      throw new Error("HTTP requests must remain within the configured API or media root.");
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(target.pathname);
    } catch {
      throw new Error("HTTP request paths must use valid percent encoding.");
    }
    if (
      hasControlCharacter(decodedPath) ||
      decodedPath.split(/[\\/]/).some((segment) => segment === "." || segment === "..")
    )
      throw new Error("HTTP request paths must not contain control or traversal segments.");
    return authenticatedFetch(
      configuration,
      fetchImplementation,
      input instanceof Request ? input : target,
      init ?? {},
      api.reportUnauthorized,
      "error",
    );
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
    error: EffectApiTypes.Error["error"],
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

/** Promise consumers receive the original public failure, never a FiberFailure string. */
export async function runEffect<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
