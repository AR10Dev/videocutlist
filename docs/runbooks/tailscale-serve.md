# Tailscale Serve

EditApp is private HTTPS behind Tailscale Serve. Do not use `tailscale funnel`; Funnel is public internet exposure and is forbidden for this deployment.

The setup script checks service readiness, configures persistent HTTPS on 443, proxies only to `http://127.0.0.1:8787`, and verifies that Funnel is absent:

```bash
sudo scripts/ops/setup-tailscale-serve.sh
sudo scripts/ops/verify-deployment.sh
```

`--bg` makes the Serve configuration persist across daemon restart and reboot. Serve terminates HTTPS using the node's tailnet certificate and injects the Tailscale identity headers only on the loopback proxy hop.

Network access belongs in tailnet grants or ACLs. App-capability forwarding needs Tailscale v1.92 or later. If this release is later configured to enforce app capabilities, pass only capability names granted by the tailnet policy:

```bash
sudo EDITAPP_TAILSCALE_APP_CAPS='example.com/cap/editapp-preview,example.com/cap/editapp-export' \
  scripts/ops/setup-tailscale-serve.sh
```

Example policy shape:

```json
{
  "grants": [{
    "src": ["group:video-editors"],
    "dst": ["tag:remote-video-host:443"],
    "app": {
      "example.com/cap/editapp-preview": [{"action":["preview"],"resources":["*"]}],
      "example.com/cap/editapp-export": [{"action":["export"],"resources":["*"]}]
    }
  }]
}
```

This server release parses forwarded capability headers but its main wiring does not yet enable a capability authorizer. Treat grants/ACLs as the current access-control boundary; do not claim the optional header forwarding restricts preview or export until an authorizer is wired in.

Check and remediate accidental exposure:

```bash
sudo tailscale serve status --json
sudo tailscale funnel status --json
# If Funnel has any endpoint, remove only the unintended Funnel configuration:
sudo tailscale funnel reset
sudo scripts/ops/setup-tailscale-serve.sh
```

`tailscale funnel reset` changes only Funnel configuration but is still an operationally destructive action; confirm its status output before running it.
