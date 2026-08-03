# Optional Tailscale Serve

Tailscale Serve is an optional private HTTPS transport. VideoCutlist also works
over a LAN, WireGuard, SSH tunnel, public HTTPS proxy, or any other reachable
standard IP network. Keep the application bound to loopback for this option:

```text
VIDEOCUTLIST_LISTEN_ADDRESS=127.0.0.1
VIDEOCUTLIST_PORT=8787
VIDEOCUTLIST_PUBLIC_BASE_URL=https://your-tailnet-hostname
```

Run the optional helper as root after VideoCutlist is healthy:

```bash
sudo VIDEOCUTLIST_TAILSCALE_APP_CAPS='example.com/cap/videocutlist' \
./deployments/connectivity-examples/tailscale/setup-tailscale-serve.sh
```

It configures persistent HTTPS on port 443 and proxies only to
`http://127.0.0.1:8787`. It never enables Tailscale Funnel. Verify the result
with `sudo tailscale serve status --json` and check that
`sudo tailscale funnel status --json` has no active endpoint.

The helper requires `VIDEOCUTLIST_TAILSCALE_APP_CAPS` and forwards it to Serve as
an optional Tailscale network-layer access gate. It is not a VideoCutlist
capability or authentication contract; configure application authentication
independently.

Serve does not select VideoCutlist authentication. Use `none` only when tailnet
access is the intended complete access boundary; use `bearer` when the app
needs its own shared credential. Do not select `trusted_proxy` solely because
Serve is present. That mode is reserved for a configured generic proxy that
sets `X-Forwarded-User` and whose immediate peer CIDR is listed in
`VIDEOCUTLIST_TRUSTED_PROXY_CIDRS`.

Tailscale ACLs or grants remain responsible for tailnet network access.
Network reachability is not application authorization; select a VideoCutlist
authentication mode when the network is not the intended complete boundary.
Do not use Funnel for VideoCutlist: Funnel creates public exposure and is outside
this optional private-connectivity example.
