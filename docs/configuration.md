# Configuration

All configuration can be done via environment variables. Copy `.env.example` to `.env` for local development.

## Environment Variables

### OpenClaw Connection

| Variable                 | Description                             | Default                  |
| ------------------------ | --------------------------------------- | ------------------------ |
| `OPENCLAW_URL`           | OpenClaw gateway URL                    | `http://127.0.0.1:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for gateway authentication | (none)                   |
| `OPENCLAW_AGENT_ID`      | Named agent to route requests to        | (none)                   |
| `OPENCLAW_TIMEOUT_MS`    | Request timeout in milliseconds         | `120000` (2 min)         |
| `OPENCLAW_MODEL`         | Model name for chat completions         | `openclaw`               |

`OPENCLAW_AGENT_ID` is sent as the `x-openclaw-agent-id` header. When unset, the gateway uses its default agent.

> **Note:** An unrecognized `OPENCLAW_AGENT_ID` is rejected by the gateway with `400 Bad Request` (`"Unknown agent '<id>'."`) — it does **not** silently fall back to the default agent. A typo will surface as a loud error, not a silent misroute.

### Multi-Instance Mode

Orchestrate multiple OpenClaw gateways from a single MCP server. Set `OPENCLAW_INSTANCES` as a JSON array — when present, it takes precedence over `OPENCLAW_URL` / `OPENCLAW_GATEWAY_TOKEN`.

```
                         ┌─────────────────┐
                         │  Claude Client   │
                         └────────┬────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │   OpenClaw MCP Bridge      │
                    │                            │
                    │   instance="prod"  ──────────────► OpenClaw GW (prod)
                    │   instance="staging" ────────────► OpenClaw GW (staging)
                    │   instance="dev"  ───────────────► OpenClaw GW (dev)
                    │   (no instance)   ──► default ──► OpenClaw GW (prod)
                    └────────────────────────────┘
```

| Variable             | Description                    | Default                       |
| -------------------- | ------------------------------ | ----------------------------- |
| `OPENCLAW_INSTANCES` | JSON array of instance configs | (none — single-instance mode) |

**Example:**

```bash
OPENCLAW_INSTANCES='[
  {"name": "prod", "url": "http://prod:18789", "token": "tok1", "default": true},
  {"name": "staging", "url": "http://staging:18789", "token": "tok2"},
  {"name": "dev", "url": "http://dev:18789", "token": "tok3"}
]'
```

Each instance object supports:

| Field     | Type    | Required | Description                                                              |
| --------- | ------- | -------- | ------------------------------------------------------------------------ |
| `name`    | string  | Yes      | Unique instance name (1-64 chars, alphanumeric/dashes/underscores)       |
| `url`     | string  | Yes      | OpenClaw gateway URL (http or https only)                                |
| `token`   | string  | No       | Bearer token for gateway authentication                                  |
| `agentId` | string  | No       | Named agent to route requests to on this instance's gateway              |
| `timeout` | number  | No       | Request timeout in ms (inherits global `OPENCLAW_TIMEOUT_MS` if omitted) |
| `default` | boolean | No       | Mark as the default instance (first instance is default if none marked)  |

`agentId` is sent as the `x-openclaw-agent-id` header. When omitted, the gateway uses its default agent. An unrecognized value is rejected with `400 Bad Request`, not silently routed to the default.

**Using instances in tools:**

All gateway-facing tools (`openclaw_chat`, `openclaw_status`, `openclaw_chat_async`) accept an optional `instance` parameter. When omitted, the default instance is used.

```
# Target a specific instance
openclaw_chat message="Hello" instance="staging"

# Check health of a specific gateway
openclaw_status instance="prod"

# List all available instances (names, URLs, default — tokens are never exposed)
openclaw_instances

# Async tasks also support instance targeting
openclaw_chat_async message="Run migration" instance="dev"

# Filter task list by instance
openclaw_task_list instance="staging"
```

**How instance resolution works:**

1. If `instance` parameter is provided → use that instance
2. If `instance` is omitted → use the instance marked as `default`
3. If no instance is marked as default → the first instance in the array is used

Each instance gets its own isolated HTTP client with independent auth token, timeout, and base URL. Async tasks store the target instance ID so results are always routed correctly.

**Docker Compose with multi-instance:**

```yaml
services:
  mcp-bridge:
    image: ghcr.io/freema/openclaw-mcp:latest
    environment:
      - OPENCLAW_INSTANCES=[{"name":"prod","url":"http://prod-gw:18789","token":"tok1","default":true},{"name":"staging","url":"http://staging-gw:18789","token":"tok2"}]
      - AUTH_ENABLED=true
      - MCP_CLIENT_ID=openclaw
      - MCP_CLIENT_SECRET=${MCP_CLIENT_SECRET}
```

**Backward compatibility:** When `OPENCLAW_INSTANCES` is not set, the server creates a single `"default"` instance from `OPENCLAW_URL` + `OPENCLAW_GATEWAY_TOKEN`. Existing deployments work without any configuration change — zero migration required.

### Server Settings (HTTP transport)

| Variable      | Description                                                       | Default                  |
| ------------- | ----------------------------------------------------------------- | ------------------------ |
| `PORT`        | HTTP server port                                                  | `3000`                   |
| `HOST`        | HTTP server host                                                  | `0.0.0.0`                |
| `DEBUG`       | Enable debug logging                                              | `false`                  |
| `TRUST_PROXY` | Express `trust proxy` setting (required behind a reverse proxy)   | (unset — trust nothing)  |

**`TRUST_PROXY` values:**

| Value          | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| (unset)        | Express default — do not trust any proxy                                       |
| `1`            | Trust one hop — typical when there is a single reverse proxy in front          |
| `true`         | Trust every proxy — only safe on a fully private network                       |
| `loopback`     | Trust `127.0.0.1` and `::1`                                                    |
| `10.0.0.0/8`   | Trust a specific IP or CIDR range                                              |

When `TRUST_PROXY` is unset and a reverse proxy injects an `X-Forwarded-For` header, the MCP SDK's `/token` handler crashes with `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` and OAuth fails. Set this whenever the server is behind Caddy, nginx, Traefik, Cloudflare Tunnel, ngrok, or any other proxy.

### CORS Configuration

| Variable       | Description                       | Default |
| -------------- | --------------------------------- | ------- |
| `CORS_ORIGINS` | Allowed origins (comma-separated) | `*`     |

**CORS_ORIGINS examples:**

- `*` — Allow all origins (not recommended for production)
- `none` — Disable CORS entirely
- `https://claude.ai` — Single origin
- `https://claude.ai,https://your-app.com` — Multiple origins
- `*.example.com` — Wildcard subdomain

### Authentication (OAuth 2.1)

The server uses the MCP SDK's built-in OAuth 2.1 server with authorization code + PKCE flow. This is what Claude.ai requires for custom MCP connectors.

| Variable            | Description                                                 | Required                   |
| ------------------- | ----------------------------------------------------------- | -------------------------- |
| `AUTH_ENABLED`      | Enable OAuth authentication (`true`/`false`)                | Yes for production         |
| `MCP_CLIENT_ID`     | OAuth client ID (e.g., `openclaw`)                          | When auth enabled          |
| `MCP_CLIENT_SECRET` | OAuth client secret                                         | When auth enabled          |
| `MCP_ISSUER_URL`    | OAuth issuer URL override (e.g., `https://mcp.example.com`) | When behind HTTPS proxy    |
| `MCP_REDIRECT_URIS` | Allowed redirect URIs (comma-separated)                     | Recommended for production |
| `MCP_DANGEROUSLY_ALLOW_DCR`        | Enable Dynamic Client Registration (`true`/`false`)         | Dev only (see below)       |
| `MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC` | Escape hatch to allow DCR on non-loopback binds             | Never, unless you mean it  |

**Client ID validation rules:**

- 3-64 characters
- Alphanumeric, dashes, underscores only
- Must start with a letter or digit

**Client Secret requirements:**

- Minimum 32 characters
- Generate a secure one: `openssl rand -hex 32`

When auth is enabled, the server exposes these OAuth 2.1 endpoints:

- `GET /.well-known/oauth-authorization-server` — OAuth server metadata
- `GET /.well-known/oauth-protected-resource/mcp` — Protected resource metadata
- `GET /authorize` — Authorization endpoint (auto-approves for pre-configured client)
- `POST /token` — Token exchange (requires client_secret)
- `POST /revoke` — Token revocation

Dynamic client registration is **disabled by default** — only the pre-configured client (from `MCP_CLIENT_ID` + `MCP_CLIENT_SECRET`) can authenticate. This prevents anyone who knows the server URL from self-registering and bypassing auth.

#### Cursor / Windsurf compatibility (dev only)

Cursor and Windsurf only support MCP servers that expose OAuth 2.0 Dynamic Client Registration (RFC 7591). To let them connect, set `MCP_DANGEROUSLY_ALLOW_DCR=true`. The server will then advertise a `/register` endpoint and accept ad-hoc client registrations (kept in an in-memory FIFO store, capped at 100 entries).

`MCP_CLIENT_ID` and `MCP_CLIENT_SECRET` are still required — DCR augments the pre-configured client, it does not replace it. If you are only running Cursor locally you can use any valid values for them; they simply remain unused.

**This is dev-only.** With DCR enabled alongside the server's auto-approve authorization flow, any client that can reach the server can register itself and obtain a token. To prevent accidental exposure the server refuses to start when `MCP_DANGEROUSLY_ALLOW_DCR=true` and `HOST` is not loopback (`127.0.0.1`, `localhost`, or `::1`). If you genuinely need DCR on a non-loopback bind (e.g., inside a trusted private network), also set `MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC=true`.

For production with Claude.ai, keep DCR disabled and use the pre-configured `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET`.
