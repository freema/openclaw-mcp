# Configuration

All configuration can be done via environment variables. Copy `.env.example` to `.env` for local development.

## Environment Variables

### OpenClaw Connection

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_URL` | OpenClaw gateway URL | `http://127.0.0.1:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for gateway authentication | (none) |
| `OPENCLAW_TIMEOUT_MS` | Request timeout in milliseconds | `120000` (2 min) |

### Server Settings (SSE transport)

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | SSE server port | `3000` |
| `HOST` | SSE server host | `0.0.0.0` |
| `DEBUG` | Enable debug logging | `false` |

### CORS Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `CORS_ORIGINS` | Allowed origins (comma-separated) | `*` |

**CORS_ORIGINS examples:**
- `*` — Allow all origins (not recommended for production)
- `none` — Disable CORS entirely
- `https://claude.ai` — Single origin
- `https://claude.ai,https://your-app.com` — Multiple origins
- `*.example.com` — Wildcard subdomain

### Authentication (OAuth 2.1)

The server uses the MCP SDK's built-in OAuth 2.1 server with authorization code + PKCE flow. This is what Claude.ai requires for custom MCP connectors.

| Variable | Description | Required |
|----------|-------------|----------|
| `AUTH_ENABLED` | Enable OAuth authentication (`true`/`false`) | Yes for production |
| `MCP_CLIENT_ID` | OAuth client ID (e.g., `openclaw`) | When auth enabled |
| `MCP_CLIENT_SECRET` | OAuth client secret | When auth enabled |
| `MCP_ISSUER_URL` | OAuth issuer URL override (e.g., `https://mcp.example.com`) | When behind HTTPS proxy |
| `MCP_REDIRECT_URIS` | Allowed redirect URIs (comma-separated) | Recommended for production |

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
