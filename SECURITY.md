# Security policy

## Supported versions

Only the latest release is supported for security fixes. Upgrade to the latest release before reporting an issue where possible. Backward compatibility with older database or configuration formats is not promised; back up application data before upgrading.

## Reporting a vulnerability

Please report vulnerabilities privately using GitHub's **Report a vulnerability** feature on this repository's Security tab. Private vulnerability reporting is enabled for this repository. Do not open a public issue for an unpatched vulnerability. Include the affected release/commit, impact, and minimal reproduction details; do not include real credentials or private media.

We will acknowledge reports and coordinate remediation and disclosure through GitHub Security Advisories. No response-time guarantee is provided. If GitHub's private reporting feature is unavailable, contact the repository maintainers privately through GitHub rather than publishing exploit details.

## Deployment guidance

Do not expose an unauthenticated (`none`) listener beyond loopback. Protect bearer tokens, restrict trusted-proxy mode to exact proxy peers, and keep MCP disabled unless required. See the [container runbook](docs/runbooks/containers.md) for network and proxy guidance.
