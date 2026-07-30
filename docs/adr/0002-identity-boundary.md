# ADR 0002: Tailscale Identity Boundary

Status: accepted

The production service listens only on loopback and trusts Tailscale headers
only from configured loopback proxy ranges. Local OS users are inside this
trust boundary. Development authentication is explicit, fixed-user, and
loopback-only. Projects and exports are owner-only. In production, preview,
export, and media-refresh work additionally require a matching Tailscale app
capability forwarded by Serve. Funnel is prohibited.
