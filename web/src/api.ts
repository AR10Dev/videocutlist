export type Authentication =
  { type: "none" } | { type: "bearer"; token: string } | { type: "cookie" };

export type ClientConfiguration = {
  serverBaseUrl: string;
  authentication: Authentication;
};

declare global {
  interface Window {
    EDITAPP_CONFIG?: ClientConfiguration;
  }
}

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

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
    throw new Error(
      "serverBaseUrl must not contain credentials, a query, or a fragment.",
    );
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/api/v1/`;
  return base;
}

function validateAuthentication(authentication: Authentication) {
  if (!authentication || typeof authentication !== "object")
    throw new Error("authentication is required.");
  if (authentication.type === "none" || authentication.type === "cookie")
    return authentication;
  if (
    authentication.type === "bearer" &&
    typeof authentication.token === "string" &&
    authentication.token.length > 0 &&
    !hasControlCharacter(authentication.token)
  )
    return authentication;
  throw new Error("Invalid authentication configuration.");
}

export function resolveBrowserConfiguration(
  browser: Window = window,
): ClientConfiguration {
  const configuration = browser.EDITAPP_CONFIG ?? {
    serverBaseUrl: browser.location.origin,
    authentication: { type: "none" as const },
  };
  apiBase(configuration.serverBaseUrl);
  return {
    serverBaseUrl: configuration.serverBaseUrl,
    authentication: validateAuthentication(configuration.authentication),
  };
}

export function createApiClient(
  configuration: ClientConfiguration,
  fetchImplementation: Fetch = fetch,
) {
  const base = apiBase(configuration.serverBaseUrl);
  const authentication = validateAuthentication(configuration.authentication);

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
    if (
      decodedPath
        .split(/[\\/]/)
        .some((segment) => segment === "." || segment === "..")
    )
      throw new Error("API paths must not contain parent-escaping segments.");
    const target = new URL(relativePath, base);
    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(base.pathname)
    )
      throw new Error("API paths must remain within /api/v1/.");
    return target.toString();
  };

  const request = (relativePath: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    const credentials = authentication.type === "cookie" ? "include" : "omit";
    if (authentication.type === "bearer")
      headers.set("Authorization", `Bearer ${authentication.token}`);
    return fetchImplementation(url(relativePath), {
      ...init,
      credentials,
      headers,
    });
  };

  return { url, request };
}
