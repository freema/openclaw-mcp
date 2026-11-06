# Changelog

Notable changes to openclaw-mcp. Versions follow [Semantic Versioning](https://semver.org/).
Releases before 1.8.1 are described in the
[GitHub releases](https://github.com/freema/openclaw-mcp/releases) and in the
"Upgrading" sections of the [README](README.md#security).

## 1.8.1 — 2026-11-06

Security and maintenance release. The MCP tool surface is unchanged and no
configuration change is required, but read the first item if you deploy with
the `docker-compose.yml` from this repository.

### Changed

- **`docker-compose.yml` publishes the port on `127.0.0.1` only**
  (`${BIND_ADDRESS:-127.0.0.1}:${PORT:-3000}:3000`). The bridge speaks plain
  HTTP and is meant to sit behind a TLS-terminating reverse proxy; Docker
  publishes ports past host firewalls, so the old `3000:3000` exposed it on
  every interface. If your reverse proxy runs on another machine, set
  `BIND_ADDRESS=0.0.0.0` (or an interface address) and firewall the port.
  Compose files you maintain yourself and plain `docker run` are not affected.
- `docker-compose.yml` drops all Linux capabilities (`cap_drop: [ALL]`) and
  passes `OPENCLAW_AGENT_ID`, `MCP_REDIRECT_URIS` and `TRUST_PROXY` through to
  the container.
- The Docker image is built on `node:24-slim` (Node.js 20 is end-of-life). The
  npm package still supports Node.js ≥ 20; CI now tests on 20, 22 and 24.
- Request bodies on `POST /mcp` and `POST /messages` are limited to 4 MiB and
  are parsed only after the bearer token has been verified. Before, Express'
  implicit 100 kB limit applied ahead of authentication.
- The startup warning for an unset `MCP_REDIRECT_URIS` now says what to set.

### Fixed

- Messages within the documented 100,000-character limit were rejected with
  `413` when they were longer than 100 kB on the wire (non-ASCII text, many
  escaped characters).
- Oversized and malformed request bodies were answered with Express' HTML
  error page, which includes a stack trace with internal paths unless
  `NODE_ENV=production`. They now get a short JSON error (JSON-RPC shaped on
  the MCP endpoints, OAuth shaped on the OAuth endpoints).

### Security

- `@modelcontextprotocol/sdk` raised to `^1.32.2` (from `^1.29.0`). Relevant
  to the HTTP transport: GHSA-f897-62hf-6gxq (no request body size / JSON-RPC
  batch limit) and GHSA-46jr-4wx8-v453 (memory exhaustion during validation).
  The same bump clears GHSA-22jm-h49p-29qw (experimental SDK tasks) and
  GHSA-6qxp-vccf-f47h (SDK OAuth client), which concern code this server does
  not use. Raising the floor makes `npm install` pick the fixed SDK as well,
  not only the Docker image.
- Transitive production dependencies updated to patched versions: `proxy-addr`
  (GHSA-jqcg-44mw-7w3h), `hono`, `@hono/node-server`, `body-parser`,
  `fast-uri`, `ip-address`, `qs` and `zod`. `npm audit --omit=dev` reports no
  vulnerabilities.
- JSON-RPC batches are capped at 100 messages (enforced by the SDK).
- `express` is now a direct dependency (it was already installed through the
  SDK) so the HTTP app can set its own body limit.

### Documentation

- Recommend running the bridge against a dedicated least-privilege OpenClaw
  agent via `OPENCLAW_AGENT_ID`: prompt injection into an agent with shell
  access is the biggest real-world risk of this setup.
- `SECURITY.md` "Authentication" rewritten to describe what the server
  actually does. It previously documented token introspection and static API
  keys, neither of which exists.
- `docs/threat-model.md` corrected (no private-IP blocking, CORS default,
  timeouts) and extended with a prompt-injection section.
- Deployment docs state that a reverse proxy is expected and explain the
  loopback port binding.
