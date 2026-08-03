# Optional reverse-proxy contract

This is optional guidance for any maintained HTTP(S) reverse proxy. VideoCutlist
does not require a proxy or a particular provider.

Keep the upstream on `127.0.0.1:8787` unless direct LAN or tunnel access is an
intentional deployment choice. Preserve streaming responses: do not buffer
preview responses, and permit long-lived streamed responses.

`VIDEOCUTLIST_AUTH_MODE=trusted_proxy` is only for a proxy that authenticates the
user and sets one bounded `X-Forwarded-User` value. Set
`VIDEOCUTLIST_TRUSTED_PROXY_CIDRS` to only the proxy's immediate source CIDR(s).
The application ignores forwarded headers from every other peer. Do not trust
client-supplied forwarded headers, and do not use this mode merely because a
network provider is present.

For a separate browser origin, configure `VIDEOCUTLIST_ALLOWED_ORIGINS` with exact
HTTP(S) origins. CORS is deny-by-default; wildcard origins are not supported.
Use `VIDEOCUTLIST_AUTH_MODE=bearer` when the proxy does not establish a user
identity, or `none` only when the surrounding network is intentionally the
complete access boundary.

No proxy configuration is included here because the correct syntax, TLS
storage, and validation command belong to the chosen proxy distribution.
