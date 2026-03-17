# Configuration

All configuration can be done via environment variables. Copy `.env.example` to `.env` for local development.

## Environment Variables

### OpenClaw Connection

| Variable                 | Description                             | Default                  |
| ------------------------ | --------------------------------------- | ------------------------ |
| `OPENCLAW_URL`           | OpenClaw gateway URL                    | `http://127.0.0.1:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for gateway authentication | (none)                   |
| `OPENCLAW_TIMEOUT_MS`    | Request timeout in milliseconds         | `120000` (2 min)         |

### Multi-Instance Mode

Orchestrate multiple OpenClaw gateways from a single MCP server. Set `OPENCLAW_INSTANCES` as a JSON array — when present, it takes precedence over `OPENCLAW_URL` / `OPENCLAW_GATEWAY_TOKEN`.

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
| `timeout` | number  | No       | Request timeout in ms (inherits global `OPENCLAW_TIMEOUT_MS` if omitted) |
| `default` | boolean | No       | Mark as the default instance (first instance is default if none marked)  |

**Using instances in tools:**

All gateway-facing tools (`openclaw_chat`, `openclaw_status`, `openclaw_chat_async`) accept an optional `instance` parameter. When omitted, the default instance is used.

```
openclaw_chat message="Hello" instance="staging"
openclaw_instances  # list all available instances
```

**Backward compatibility:** When `OPENCLAW_INSTANCES` is not set, the server creates a single `"default"` instance from `OPENCLAW_URL` + `OPENCLAW_GATEWAY_TOKEN`. Existing deployments work without any configuration change.

### Server Settings (SSE transport)

| Variable | Description          | Default   |
| -------- | -------------------- | --------- |
| `PORT`   | SSE server port      | `3000`    |
| `HOST`   | SSE server host      | `0.0.0.0` |
| `DEBUG`  | Enable debug logging | `false`   |

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

**Client ID validation rules:**

- 3–64 characters
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

Dynamic client registration is **disabled** — only the pre-configured client (from `MCP_CLIENT_ID` + `MCP_CLIENT_SECRET`) can authenticate. This prevents anyone who knows the server URL from self-registering and bypassing auth.
