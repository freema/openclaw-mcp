<!-- mcp-name: io.github.freema/openclaw-mcp -->

# OpenClaw MCP Server

[![npm version](https://badge.fury.io/js/openclaw-mcp.svg)](https://www.npmjs.com/package/openclaw-mcp)
[![CI](https://github.com/freema/openclaw-mcp/workflows/CI/badge.svg)](https://github.com/freema/openclaw-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Ffreema%2Fopenclaw--mcp-blue?logo=github)](https://github.com/freema/openclaw-mcp/pkgs/container/openclaw-mcp)
[![Website](https://img.shields.io/badge/Website-openclaw--mcp.cloud-e24b4a)](https://openclaw-mcp.cloud)

<a href="https://glama.ai/mcp/servers/@freema/openclaw-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@freema/openclaw-mcp/badge" />
</a>

🦞 Model Context Protocol (MCP) server for [OpenClaw](https://github.com/openclaw/openclaw) AI assistant integration.

## Demo

<p align="center">
  <img src="docs/assets/claude-ai-demo.gif" alt="OpenClaw MCP in Claude.ai" width="720" />
</p>

## Why I Built This

Hey! I created this MCP server because I didn't want to rely solely on messaging channels to communicate with OpenClaw. What really excites me is the ability to connect OpenClaw to the Claude web UI. Essentially, my chat can delegate tasks to my Claw bot, which then handles everything else — like spinning up Claude Code to fix issues for me.

Think of it as an AI assistant orchestrating another AI assistant. Pretty cool, right?

## Quick Start

### Docker (Recommended)

Pre-built images are published to GitHub Container Registry on every release.

```bash
docker pull ghcr.io/freema/openclaw-mcp:latest
```

Create a `docker-compose.yml`:

```yaml
services:
  mcp-bridge:
    image: ghcr.io/freema/openclaw-mcp:latest
    container_name: openclaw-mcp
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - OPENCLAW_URL=http://host.docker.internal:18789
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - OPENCLAW_AGENT_ID=${OPENCLAW_AGENT_ID:-}
      - OPENCLAW_MODEL=openclaw
      - AUTH_ENABLED=true
      - MCP_CLIENT_ID=openclaw
      - MCP_CLIENT_SECRET=${MCP_CLIENT_SECRET}
      - MCP_ISSUER_URL=${MCP_ISSUER_URL:-}
      - MCP_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback
      - TRUST_PROXY=1
      - CORS_ORIGINS=https://claude.ai
    extra_hosts:
      - "host.docker.internal:host-gateway"
    read_only: true
    security_opt:
      - no-new-privileges
```

Generate secrets and start:

```bash
export MCP_CLIENT_SECRET=$(openssl rand -hex 32)
export OPENCLAW_GATEWAY_TOKEN=your-gateway-token
docker compose up -d
```

Then in Claude.ai add a custom MCP connector pointing to `https://your-domain.com/mcp` with `MCP_CLIENT_ID=openclaw` and your `MCP_CLIENT_SECRET`.

> **Important:** The connector URL **must end with `/mcp`** — that's the Streamable HTTP endpoint. A bare domain (`https://your-domain.com`) hits the server root and returns 404 after OAuth completes.

> **Tip:** Pin a specific version instead of `latest` for production: `ghcr.io/freema/openclaw-mcp:1.1.0`

### Local (Claude Desktop)

```bash
npx openclaw-mcp
```

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "npx",
      "args": ["openclaw-mcp"],
      "env": {
        "OPENCLAW_URL": "http://127.0.0.1:18789",
        "OPENCLAW_GATEWAY_TOKEN": "your-gateway-token",
        "OPENCLAW_AGENT_ID": "main",
        "OPENCLAW_MODEL": "openclaw",
        "OPENCLAW_TIMEOUT_MS": "300000"
      }
    }
  }
}
```

### Remote (Claude.ai) without Docker

```bash
AUTH_ENABLED=true MCP_CLIENT_ID=openclaw MCP_CLIENT_SECRET=your-secret \
  MCP_ISSUER_URL=https://mcp.your-domain.com \
  CORS_ORIGINS=https://claude.ai OPENCLAW_GATEWAY_TOKEN=your-gateway-token \
  npx openclaw-mcp --transport http --port 3000
```

> **Important:** When running behind a reverse proxy (Caddy, nginx, Traefik, Cloudflare Tunnel, etc.) you **must** set:
> - `MCP_ISSUER_URL` (or `--issuer-url`) to your public HTTPS URL — otherwise OAuth metadata advertises `http://localhost:3000` and clients fail to authenticate.
> - `TRUST_PROXY=1` (or `--trust-proxy 1`) — otherwise `express-rate-limit` rejects the proxy's `X-Forwarded-For` header and `/token` crashes with `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`.

> **Recommended:** Set `MCP_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback` so authorization codes can only be delivered to Claude's callbacks. Note the exact `/api/mcp/auth_callback` path — matching is exact, and getting it wrong fails OAuth with `Unregistered redirect_uri` (see [Troubleshooting](docs/deployment.md#invalid_request--unregistered-redirect_uri-on-authorize)).

See [Installation Guide](docs/installation.md) for details.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Your Server                             │
│                                                                 │
│  ┌─────────────────┐      ┌─────────────────────────┐          │
│  │   OpenClaw      │      │    OpenClaw MCP         │          │
│  │   Gateway       │◄────►│    Bridge Server        │          │
│  │   :18789        │      │    :3000                │          │
│  │                 │      │                         │          │
│  │  OpenAI-compat  │      │  - OAuth 2.1 auth       │          │
│  │  /v1/chat/...   │      │  - CORS protection      │          │
│  └─────────────────┘      │  - Input validation     │          │
│                           └──────────┬──────────────┘          │
│                                      │                          │
└──────────────────────────────────────┼──────────────────────────┘
                                       │ HTTPS + OAuth 2.1
                                       ▼
                              ┌─────────────────┐
                              │   Claude.ai     │
                              │   (MCP Client)  │
                              └─────────────────┘
```

## Available Tools

### Sync Tools

| Tool | Description |
|------|-------------|
| `openclaw_chat` | Send messages to OpenClaw and get responses |
| `openclaw_status` | Check OpenClaw gateway health |
| `openclaw_instances` | List all configured OpenClaw instances |

### Async Tools (for long-running operations)

| Tool | Description |
|------|-------------|
| `openclaw_chat_async` | Queue a message, get task_id immediately |
| `openclaw_task_status` | Check task progress and get results |
| `openclaw_task_list` | List your tasks with filtering |
| `openclaw_task_cancel` | Cancel a pending task |

Tasks are scoped to the MCP connection that created them. In HTTP mode, where
one process serves many clients, a client can only see and cancel its own
tasks — another client's `task_id` reads as "not found" even if it is known.
Reconnecting starts a fresh scope, so poll a task on the connection that
queued it.

## Multi-Instance Mode

Orchestrate multiple OpenClaw gateways from a single MCP server. One bridge, many claws — route requests to prod, staging, dev, or whatever you name them (lobster-supreme and the-claw-abides are perfectly valid names).

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Claude.ai / Claude Desktop                    │
│                              (MCP Client)                            │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     OpenClaw MCP Bridge Server                        │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │  Instance     │  │  Instance     │  │  Instance     │              │
│  │  Registry     │  │  Resolver     │  │  Validator    │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│         │                 │                  │                        │
│  ┌──────┴─────────────────┴──────────────────┴───────┐               │
│  │              Per-Instance OpenClaw Clients          │              │
│  │     (separate auth, timeout, URL per instance)     │              │
│  └────────┬──────────────┬──────────────┬────────────┘               │
└───────────┼──────────────┼──────────────┼────────────────────────────┘
            │              │              │
            ▼              ▼              ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │  🦞 prod     │ │  🦞 staging  │ │  🦞 dev      │
   │  (default)   │ │              │ │              │
   │  :18789      │ │  :18789      │ │  :18789      │
   │  OpenClaw GW │ │  OpenClaw GW │ │  OpenClaw GW │
   └──────────────┘ └──────────────┘ └──────────────┘
```

### Setup

```bash
OPENCLAW_INSTANCES='[
  {"name": "prod", "url": "http://prod:18789", "token": "tok1", "default": true},
  {"name": "staging", "url": "http://staging:18789", "token": "tok2"},
  {"name": "dev", "url": "http://dev:18789", "token": "tok3"}
]'
```

### Usage

All tools accept an optional `instance` parameter to target a specific gateway:

```
# Chat with staging instance
openclaw_chat message="Deploy status?" instance="staging"

# Check health of prod
openclaw_status instance="prod"

# List all configured instances
openclaw_instances

# Async task targeting dev
openclaw_chat_async message="Run tests" instance="dev"
```

When `instance` is omitted, the default instance is used. Each instance has its own auth token, timeout, and URL — fully isolated.

### Key Features

- **Zero-migration upgrade** — existing single-instance deployments work without any config change
- **Per-instance isolation** — separate auth tokens, timeouts, and URLs
- **Dynamic routing** — Claude picks the right instance per request
- **Task tracking** — async tasks remember which instance they target
- **Security** — tokens are never exposed via `openclaw_instances`

See [Configuration — Multi-Instance Mode](docs/configuration.md#multi-instance-mode) for the full reference.

## Documentation

- [Installation](docs/installation.md) — Setup for Claude Desktop & Claude.ai
- [Configuration](docs/configuration.md) — Environment variables & options
- [Deployment](docs/deployment.md) — Docker & production setup
- [Threat Model](docs/threat-model.md) — What Claude can/can't trigger, trust boundaries & attack surfaces
- [Logging](docs/logging.md) — What gets logged, where, and what is never logged
- [Development](docs/development.md) — Contributing & adding tools
- [Security](SECURITY.md) — Security policy & best practices

## Security

⚠️ **Always enable authentication in production!**

```bash
# Generate secure client secret
export MCP_CLIENT_SECRET=$(openssl rand -hex 32)

# Run with auth enabled
AUTH_ENABLED=true MCP_CLIENT_ID=openclaw MCP_CLIENT_SECRET=$MCP_CLIENT_SECRET \
  openclaw-mcp --transport http
```

CORS is disabled unless you opt in. Set `CORS_ORIGINS` only when a browser
client needs to reach the server directly:

```bash
CORS_ORIGINS=https://claude.ai,https://your-app.com
```

See [Configuration](docs/configuration.md) for all security options.

### Upgrading to 1.7.0

Two defaults changed for security. Both only affect HTTP mode; stdio is
unchanged.

- **CORS is now off by default.** Previously an unset `CORS_ORIGINS` sent
  `Access-Control-Allow-Origin: *`. If a browser client depends on that, set
  the origins explicitly (`CORS_ORIGINS=https://your-app.com`), or
  `CORS_ORIGINS=*` to restore the old behaviour.
- **Async tasks are scoped to the connection that created them.** A client
  that used to poll a `task_id` queued by a different connection will now get
  "not found".

## Migrating from SSE to HTTP transport

**The legacy SSE transport was removed in v2.0.** `--transport sse` now exits with an error, and `GET /sse` / `POST /messages` answer `410 Gone`. Use Streamable HTTP:

| Before (≤ 1.x) | After (2.0) |
|--------|-------|
| `--transport sse` | `--transport http` |
| Endpoint: `GET /sse` + `POST /messages` | Endpoint: `ALL /mcp` |
| Health: `"legacySseSupported": true` | Health: `"legacySseSupported": false` |

### Migration steps

1. **CLI / Docker**: Replace `--transport sse` with `--transport http`
   ```bash
   # Before
   openclaw-mcp --transport sse --port 3000
   # After
   openclaw-mcp --transport http --port 3000
   ```

2. **Claude.ai connector URL**: No change needed — Claude.ai already uses `/mcp` (Streamable HTTP)

3. **Legacy clients**: Any client that only speaks HTTP+SSE must be upgraded. The MCP specification deprecated that transport in 2025-03-26 and removed it in 2026-07-28.

> **Note on protocol versions:** 2.0 runs on MCP SDK v2 and is stateless — it no longer keeps per-connection sessions. Clients still speaking the 2025-11-25 protocol (including current Claude.ai and Claude Desktop) are served through the SDK's built-in stateless legacy path and need no changes.

## Roadmap — v2.0 (in development)

Version 2.0 is being developed on the `v2` branch, targeting the [MCP 2026-07-28 specification](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) on MCP SDK v2 (`@modelcontextprotocol/server`).

Done on the `v2` branch:

- **Stateless protocol core** — no sessions; any instance can serve any request, so the server runs behind a plain load balancer. 2025-era clients (current Claude.ai / Claude Desktop) are served through the SDK's built-in legacy fallback.
- **Streaming to the gateway** — async tasks use `stream: true` with an idle timeout (resets on every chunk), live progress (`progress_chars`), configurable concurrency (`OPENCLAW_TASK_CONCURRENCY`), and cancellation of running tasks (fixes [#31](https://github.com/freema/openclaw-mcp/issues/31))
- **Own OAuth 2.1 authorization server** — SDK v2 is resource-server-only, so `/authorize`, `/token`, `/revoke`, `/register` and RFC 8414 metadata are implemented in-repo (PKCE S256, timing-safe client auth, refresh rotation, rate limiting)
- **zod v4 tool schemas** (JSON Schema 2020-12) and tool annotations
- **Legacy SSE transport removed** — `/sse` and `/messages` answer 410 Gone

Planned before 2.0.0 final:

- **Structured tool outputs** (`outputSchema` + `structuredContent`)
- **Client ID Metadata Documents** as the successor to Dynamic Client Registration
- **Protocol-native Tasks** (`io.modelcontextprotocol/tasks` extension) — will replace the custom async task tools once the SDK ships a tasks runtime (v2.0.0-beta.4 defines only the wire vocabulary)
- Docs refresh + migration guide from 1.x

v1.x remains the stable release until 2.0 ships.

## Requirements

- Node.js ≥ 20
- OpenClaw gateway running with HTTP API enabled:
  ```json5
  // openclaw.json
  { "gateway": { "http": { "endpoints": { "chatCompletions": { "enabled": true } } } } }
  ```

## License

MIT

## Author

Created by [Tomáš Grasl](https://www.tomasgrasl.cz/)

## Related Projects

- [OpenClaw](https://github.com/openclaw/openclaw) — The AI assistant this MCP connects to
- [MCP Specification](https://spec.modelcontextprotocol.io/) — Model Context Protocol docs
