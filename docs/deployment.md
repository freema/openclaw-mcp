# Docker Deployment

## docker-compose.yml

The provided `docker-compose.yml` runs the MCP bridge server in a hardened container.
The OpenClaw gateway runs on your host machine (or elsewhere) — the bridge connects to it
via `host.docker.internal`.

```yaml
services:
  mcp-bridge:
    image: ghcr.io/freema/openclaw-mcp:latest
    container_name: openclaw-mcp
    restart: unless-stopped
    ports:
      - "${BIND_ADDRESS:-127.0.0.1}:${PORT:-3000}:3000"
    environment:
      - OPENCLAW_URL=${OPENCLAW_URL:-http://host.docker.internal:18789}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-}
      - OPENCLAW_AGENT_ID=${OPENCLAW_AGENT_ID:-}
      - OPENCLAW_MODEL=${OPENCLAW_MODEL:-openclaw}
      - DEBUG=${DEBUG:-false}
      - MCP_CLIENT_ID=${MCP_CLIENT_ID:-openclaw}
      - MCP_CLIENT_SECRET=${MCP_CLIENT_SECRET:-}
      - MCP_ISSUER_URL=${MCP_ISSUER_URL:-}
      - MCP_REDIRECT_URIS=${MCP_REDIRECT_URIS:-}
      - TRUST_PROXY=${TRUST_PROXY:-}
      - CORS_ORIGINS=${CORS_ORIGINS:-https://claude.ai}
      - NODE_ENV=production
    extra_hosts:
      - "host.docker.internal:host-gateway"
    read_only: true
    tmpfs:
      - /tmp
    deploy:
      resources:
        limits:
          memory: 256M
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges
```

To build the image from source instead of pulling it, add
`-f docker-compose.yml -f docker-compose.dev.yml` to the `docker compose` command.

### The port is published on loopback only

The bridge speaks plain HTTP and expects a TLS-terminating
[reverse proxy](#reverse-proxy-https) in front of it. Since 1.8.1 the compose
file publishes the port as `127.0.0.1:3000`, so the container is reachable from
a proxy on the same host but not directly from the network. Docker publishes
ports past host firewalls such as `ufw`, so an unqualified `3000:3000` is
exposed even when the firewall says otherwise.

- Proxy on the same host (nginx, Caddy, Tailscale Serve, Cloudflare Tunnel):
  nothing to change, point it at `http://127.0.0.1:3000`.
- Proxy in the same compose project: it reaches the bridge over the compose
  network (`openclaw-mcp:3000`), the published port is not involved.
- Proxy on another machine: set `BIND_ADDRESS=0.0.0.0` (or a specific
  interface address) in `.env` and restrict the port to that machine with a
  firewall.

## .env

```bash
# Token for OpenClaw gateway authentication
OPENCLAW_GATEWAY_TOKEN=your-gateway-token

# Dedicated least-privilege OpenClaw agent for the bridge (strongly recommended)
OPENCLAW_AGENT_ID=mcp-bridge

# MCP OAuth client credentials
# Generate secret with: openssl rand -hex 32
MCP_CLIENT_ID=openclaw
MCP_CLIENT_SECRET=your-client-secret

# Public URL (required when behind a reverse proxy)
MCP_ISSUER_URL=https://mcp.your-domain.com

# Trust the reverse proxy's X-Forwarded-For (required behind a reverse proxy)
TRUST_PROXY=1

# Allowed OAuth redirect URIs — Claude.ai callbacks (recommended for production)
MCP_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback

# Allowed CORS origins
CORS_ORIGINS=https://claude.ai
```

## Quick Start

```bash
# Copy and edit environment
cp .env.example .env
# Edit .env with your settings

# Start the MCP bridge
docker compose up -d
```

## Security Checklist

- [ ] HTTPS enabled (via reverse proxy in front of the MCP bridge)
- [ ] OAuth configured (`MCP_CLIENT_ID` + `MCP_CLIENT_SECRET`; mandatory since 1.8.0)
- [ ] `MCP_CLIENT_ID` is valid (3–64 chars, alphanumeric/dashes/underscores)
- [ ] `MCP_CLIENT_SECRET` generated securely (`openssl rand -hex 32`, min 32 chars)
- [ ] `MCP_ISSUER_URL` set to public HTTPS URL (when behind reverse proxy)
- [ ] `TRUST_PROXY` set to the right hop count / CIDR (when behind reverse proxy)
- [ ] `MCP_REDIRECT_URIS` restricted to known callback URLs (for Claude.ai: `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback`)
- [ ] CORS restricted to known origins (`CORS_ORIGINS=https://claude.ai`)
- [ ] `OPENCLAW_GATEWAY_TOKEN` set for gateway authentication
- [ ] `OPENCLAW_AGENT_ID` points at a dedicated least-privilege agent, not your main agent (see [below](#use-a-least-privilege-openclaw-agent))
- [ ] Dynamic client registration is disabled (default — no `/register` endpoint)
- [ ] Bridge port published on `127.0.0.1` only (compose default since 1.8.1), reachable through the reverse proxy
- [ ] Container runs read-only with `cap_drop: [ALL]` and `no-new-privileges`

## Use a least-privilege OpenClaw agent

OAuth decides who may talk to the bridge. It says nothing about what the text
they send makes the OpenClaw agent do. Content that Claude reads — web pages,
emails, documents — can carry instructions that end up in an `openclaw_chat`
call, and the agent will act on them with every tool it has. If that agent can
run shell commands, a successful prompt injection is remote code execution on
your OpenClaw host. This is the biggest real-world risk of exposing OpenClaw
through the bridge.

Limit the blast radius on the OpenClaw side:

1. Create a dedicated agent for the bridge instead of using your main one.
2. Give it only the tools the Claude integration needs. Deny `exec`/`process`
   and the file-writing tools unless you really need them, and run it
   sandboxed. OpenClaw's
   [multi-agent sandbox and tools](https://docs.openclaw.ai/tools/multi-agent-sandbox-tools)
   documentation has the configuration keys for your version.
3. Route the bridge to it with `OPENCLAW_AGENT_ID=<agent id>` (per instance:
   `agentId` in `OPENCLAW_INSTANCES`). The gateway rejects an unknown agent ID
   with `400` instead of falling back to the default agent.

## Reverse Proxy (HTTPS)

The MCP bridge must be served over HTTPS for production use. Use a reverse proxy that handles TLS termination.

> **Important:** When running behind a reverse proxy you **must** set both:
> - `MCP_ISSUER_URL` to your public HTTPS URL — otherwise OAuth metadata endpoints advertise `http://localhost:3000` and MCP clients (including Claude.ai) fail to authenticate with `Protected resource http://localhost:3000/mcp does not match expected https://your-domain.com/mcp`.
> - `TRUST_PROXY=1` so Express trusts the proxy's `X-Forwarded-For` header — otherwise `express-rate-limit` (used by the MCP SDK auth handlers) crashes `/token` with `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`.
>
> Running **bare-metal with a loopback bind** (`HOST=127.0.0.1`) behind a proxy that preserves the public `Host` header (Tailscale Serve, nginx with `proxy_set_header Host $host`)? Also set `ALLOWED_HOSTS=<your-public-hostname>` — otherwise DNS-rebinding protection rejects every proxied request with `403 Invalid Host`. See [Server Settings](configuration.md#server-settings-http-transport).

### Caddy (recommended)

Caddy automatically provisions Let's Encrypt certificates.

```
mcp.your-domain.com {
    reverse_proxy openclaw-mcp:3000
}
```

Add to your `docker-compose.yml`:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

  mcp-bridge:
    # ... (same as above, but remove the ports section)
    expose:
      - "3000"
    environment:
      - MCP_ISSUER_URL=https://mcp.your-domain.com
      - TRUST_PROXY=1
      # ... other env vars

volumes:
  caddy-data:
  caddy-config:
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## OpenClaw Gateway Prerequisites

The MCP bridge communicates with the OpenClaw gateway via its OpenAI-compatible HTTP API (`/v1/chat/completions`). This endpoint is **disabled by default** — you must enable it in your OpenClaw config:

```json5
// openclaw.json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

Without this, the MCP bridge will receive `405 Method Not Allowed` from the gateway.

## Bridge / Gateway Compatibility

| MCP Bridge | Gateway | Result |
|------------|---------|--------|
| ≤ 1.2.2 | ≥ 2026.3.24 | `400 Bad Request` — bridge sends `model: "claude-opus-4-5"`, gateway rejects it |
| ≥ 1.3.0 | ≥ 2026.3.24 | Works — bridge defaults to `model: "openclaw"` |
| ≥ 1.3.0 | older | Works — set `OPENCLAW_MODEL` to whatever the older gateway expects |

If you're running a non-standard gateway setup with custom agent routing, set `OPENCLAW_MODEL=openclaw/<agentId>` to match your configuration.

## Troubleshooting

### `400 Bad Request` from gateway on `openclaw_chat`

Gateway versions 2026.3.24+ require `model: "openclaw"` (or `"openclaw/<agentId>"`). The MCP bridge defaults to `"openclaw"` since v1.3.0. If you're using an older bridge version, upgrade or set `OPENCLAW_MODEL=openclaw`. If you need custom model routing, set `OPENCLAW_MODEL` to the value your gateway expects.

To diagnose, enable debug logging (`DEBUG=true`) which logs the outgoing request body and gateway error responses.

### `405 Method Not Allowed` from gateway

The OpenClaw gateway's HTTP chat completions endpoint is disabled by default. Enable it in `openclaw.json` — see [Gateway Prerequisites](#openclaw-gateway-prerequisites) above.

### `Protected resource http://localhost:3000/mcp does not match expected https://...`

You're running behind a reverse proxy but haven't set `MCP_ISSUER_URL`. The OAuth metadata endpoints are advertising `http://localhost:3000` instead of your public HTTPS URL. Set `MCP_ISSUER_URL` to your public URL (e.g., `https://mcp.your-domain.com`) or pass `--issuer-url` on the CLI.

### `POST /` or `GET /` returns 404 after OAuth succeeds

Your Claude.ai connector URL is missing the `/mcp` path. The MCP Streamable HTTP transport is mounted at `/mcp`, not at the server root (which is intentional — root is reserved for `/health`, `/.well-known/*`, OAuth endpoints, and legacy SSE endpoints). Update the connector URL in Claude.ai to end with `/mcp`, e.g. `https://mcp.your-domain.com/mcp`.

### `invalid_request` / `Unregistered redirect_uri` on `/authorize`

The `redirect_uri` the client sent is not on the server's allow-list. Two common causes:

1. **`MCP_REDIRECT_URIS` is set but doesn't contain the client's exact callback.** Claude.ai uses `https://claude.ai/api/mcp/auth_callback` (and `https://claude.com/api/mcp/auth_callback`) — a similar-looking entry like `https://claude.ai/oauth/callback` does **not** match. Matching is exact on scheme, host, and path; only loopback callbacks (`localhost`, `127.0.0.1`, `[::1]`) get port relaxation per RFC 8252.

2. **You're on bridge ≤ 1.5.0 with `MCP_REDIRECT_URIS` unset.** The allow-any fallback in those versions was silently broken by a change in MCP SDK 1.29 (the SDK switched its membership check from `.includes()` to `.some()`), so *every* redirect_uri was rejected — fresh `npx openclaw-mcp@latest` installs picked the new SDK up automatically. Upgrade to bridge ≥ 1.6.0, or set `MCP_REDIRECT_URIS` explicitly (recommended for production anyway):

```bash
MCP_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback
```

### `ValidationError: ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on `/token`

The server is behind a reverse proxy that sets `X-Forwarded-For`, but Express's `trust proxy` is left at its default (`false`). The MCP SDK's OAuth handlers use `express-rate-limit`, which refuses to read the forwarded header in that configuration and crashes the request. Set `TRUST_PROXY=1` (single proxy in front) or `--trust-proxy 1`. Use a higher hop count, a CIDR/IP, or a keyword (`loopback`, `linklocal`, `uniquelocal`) for more complex topologies — see [Server Settings](configuration.md#server-settings-http-transport).

### `fetch failed` / MCP bridge can't reach gateway

When both services run in Docker, the MCP bridge must connect via the Docker network hostname (e.g., `http://openclaw-gateway:18789`), not `localhost`. Make sure both containers are on the same Docker network.
