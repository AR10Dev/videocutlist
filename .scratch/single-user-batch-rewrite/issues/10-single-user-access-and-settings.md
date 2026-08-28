# 10: Simplify access control and settings for one user

**What to build:** One deployment access gate and settings contract without application users, ownership, roles, or browser-visible filesystem paths.

**Blocked by:** 01

**Category:** enhancement
**Status:** ready-for-agent

- [ ] Application interfaces and HTTP handlers accept no principal, owner, role, or capability values.
- [ ] Loopback-only mode may run without authentication.
- [ ] Non-loopback application access requires one configured bearer token or an explicitly trusted authenticating reverse proxy.
- [ ] Proxy mode trusts requests only from configured proxy addresses and consumes no forwarded user identity.
- [ ] Unsafe browser mutations reject a foreign `Origin`; CORS remains deny-by-default.
- [ ] Media roots, destination paths, executable paths, database path, and mounts are deployment-only settings.
- [ ] Browser-visible server settings contain safe aliases, availability, and tunable limits without original-media or destination paths.
- [ ] Browser editor preferences remain in local storage.
- [ ] Security, API, and configuration tests cover loopback, remote access, proxy trust, token comparison, origin rejection, and path redaction.

## Comments
