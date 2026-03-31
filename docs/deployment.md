# Docker Deployment

## docker-compose.yml

The provided `docker-compose.yml` runs the MCP bridge server in a hardened container.
The OpenClaw gateway runs on your host machine (or elsewhere) — the bridge connects to it
via `host.docker.internal`.

```yaml
services:
  mcp-bridge:
    build: .
    container_name: openclaw-mcp
    restart: unless-stopped
    ports:
      - "${PORT:-3000}:3000"
    environment:
      - OPENCLAW_URL=${OPENCLAW_URL:-http://host.docker.internal:18789}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-}
      - OPENCLAW_MODEL=${OPENCLAW_MODEL:-openclaw}
      - DEBUG=${DEBUG:-false}
      - AUTH_ENABLED=${AUTH_ENABLED:-true}
      - MCP_CLIENT_ID=${MCP_CLIENT_ID:-openclaw}
      - MCP_CLIENT_SECRET=${MCP_CLIENT_SECRET:-}
      - MCP_ISSUER_URL=${MCP_ISSUER_URL:-}
      - MCP_REDIRECT_URIS=${MCP_REDIRECT_URIS:-}
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
    security_opt:
      - no-new-privileges
```

## .env

```bash
# Token for OpenClaw gateway authentication
OPENCLAW_GATEWAY_TOKEN=your-gateway-token

# MCP OAuth client credentials
# Generate secret with: openssl rand -hex 32
MCP_CLIENT_ID=openclaw
MCP_CLIENT_SECRET=your-client-secret

# Enable OAuth (required for production SSE)
AUTH_ENABLED=true

# Public URL (required when behind a reverse proxy)
MCP_ISSUER_URL=https://mcp.your-domain.com

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
- [ ] OAuth enabled (`AUTH_ENABLED=true`)
- [ ] `MCP_CLIENT_ID` is valid (3–64 chars, alphanumeric/dashes/underscores)
- [ ] `MCP_CLIENT_SECRET` generated securely (`openssl rand -hex 32`, min 32 chars)
- [ ] `MCP_ISSUER_URL` set to public HTTPS URL (when behind reverse proxy)
- [ ] `MCP_REDIRECT_URIS` restricted to known callback URLs
- [ ] CORS restricted to known origins (`CORS_ORIGINS=https://claude.ai`)
- [ ] `OPENCLAW_GATEWAY_TOKEN` set for gateway authentication
- [ ] Dynamic client registration is disabled (default — no `/register` endpoint)
- [ ] Container runs read-only with no-new-privileges

## Reverse Proxy (HTTPS)

The MCP bridge must be served over HTTPS for production use. Use a reverse proxy that handles TLS termination.

> **Important:** You **must** set `MCP_ISSUER_URL` to your public HTTPS URL. Without this, OAuth metadata endpoints will advertise `http://localhost:3000` and MCP clients (including Claude.ai) will fail to authenticate with the error: `Protected resource http://localhost:3000/mcp does not match expected https://your-domain.com/mcp`.

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
        proxy_pass http://localhost:3000;
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

### `fetch failed` / MCP bridge can't reach gateway

When both services run in Docker, the MCP bridge must connect via the Docker network hostname (e.g., `http://openclaw-gateway:18789`), not `localhost`. Make sure both containers are on the same Docker network.
