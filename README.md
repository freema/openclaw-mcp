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
| `openclaw_task_list` | List all tasks with filtering |
| `openclaw_task_cancel` | Cancel a pending task |

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

Configure CORS to restrict access:

```bash
CORS_ORIGINS=https://claude.ai,https://your-app.com
```

See [Configuration](docs/configuration.md) for all security options.

## Migrating from SSE to HTTP transport

Starting with v1.5.0, the primary transport is **Streamable HTTP** (`--transport http`). The legacy SSE transport (`--transport sse`) is deprecated but still works for backward compatibility.

### What changed

| Before | After |
|--------|-------|
| `--transport sse` | `--transport http` (recommended) |
| Primary endpoint: `GET /sse` | Primary endpoint: `POST/GET/DELETE /mcp` |
| Health: `"transport": "sse"` | Health: `"transport": "streamable-http"` |

### Migration steps

1. **CLI / Docker**: Replace `--transport sse` with `--transport http`
   ```bash
   # Before
   openclaw-mcp --transport sse --port 3000
   # After
   openclaw-mcp --transport http --port 3000
   ```

2. **Claude.ai connector URL**: No change needed — Claude.ai already uses `/mcp` (Streamable HTTP)

3. **Legacy clients**: The `/sse` and `/messages` endpoints still work. A deprecation warning is logged on each SSE connection.

4. **Dockerfile ENTRYPOINT**: Updated automatically if using the official Docker image

> **Note:** `--transport sse` will continue to work as a deprecated alias. Both transports are served simultaneously regardless of which flag you use.

## Roadmap — v2.0 (in development)

Version 2.0 is being developed on the `v2` branch, targeting the [MCP 2026-07-28 specification](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) and the new MCP SDK v2 (`@modelcontextprotocol/server`). Planned changes:

- **Stateless protocol core** — no sessions, no `initialize` handshake; runs behind any load balancer without sticky routing
- **Protocol-native Tasks** (`io.modelcontextprotocol/tasks` extension) — replaces the custom async task tools (`openclaw_chat_async`, `openclaw_task_status`, `openclaw_task_list`, `openclaw_task_cancel`) with standard `tasks/get` polling
- **Streaming to the gateway** — `stream: true` on `/v1/chat/completions` for live progress tracking (fixes [#31](https://github.com/freema/openclaw-mcp/issues/31)) and concurrent task processing
- **Modern auth** — Client ID Metadata Documents replace Dynamic Client Registration (the `MCP_DANGEROUSLY_ALLOW_DCR` escape hatch goes away)
- **Structured tool outputs** (`outputSchema` + `structuredContent`) and tool icons
- **Legacy SSE transport removed** (deprecated since spec 2025-03-26)

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
