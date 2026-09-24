import type { components } from "./generated/api";

/** Decode only the public error envelope; malformed/proxy errors retain a safe fallback. */
export async function readApiError(
  response: Response,
  fallback = "Request could not be completed.",
): Promise<components["schemas"]["Error"]["error"]> {
  const body: unknown = await response.json().catch(() => undefined);
  if (body && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code &&
      "message" in error &&
      typeof error.message === "string" &&
      "requestId" in error &&
      typeof error.requestId === "string"
    )
      return { code: error.code, message: error.message, requestId: error.requestId };
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

export function createApiClient(
  configuration: ClientConfiguration,
  fetchImplementation: Fetch = fetch,
) {
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
      if (
        response.status === 401 &&
        configuration.authentication === authentication &&
        !init.signal?.aborted &&
        typeof window !== "undefined"
      )
        window.dispatchEvent(new Event(authenticationRequiredEvent));
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
  const interchangeRequest = (
    projectId: string,
    format: "csv" | "chapters",
    init: RequestInit = {},
    projectItemId?: string,
  ) =>
    request(
      `projects/${encodeURIComponent(projectId)}/interchange/${format}${projectItemId ? `?itemId=${encodeURIComponent(projectItemId)}` : ""}`,
      init,
    );
  return { url, request, assetRequest, interchangeRequest };
}

export type ApiClient = ReturnType<typeof createApiClient>;
