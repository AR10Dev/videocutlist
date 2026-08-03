# ADR 0002: Provider-Neutral Identity Boundary

Status: accepted

The production service binds to loopback by default and may use an explicit
firewall-protected LAN IP. Authentication is explicit: `none`, fixed-token
`bearer`, or `trusted_proxy`. The last mode accepts a bounded
`X-Forwarded-User` only after generic proxy middleware verifies the immediate
peer CIDR; no network product or raw header establishes identity. Projects and
exports remain owner-only. Optional connectivity products stay outside runtime
and primary deployment. Funnel is prohibited in optional examples.
