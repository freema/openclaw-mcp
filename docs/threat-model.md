# Threat Model

## Architecture Overview

```
Claude (Desktop / Claude.ai)
    |
    | MCP Protocol (stdio or Streamable HTTP)
    v
OpenClaw MCP Server (this project)
    |
    | OpenAI-compatible REST API (POST /v1/chat/completions)
    v
OpenClaw Gateway (user-controlled)
```

The MCP server is a **stateless proxy** — it translates MCP tool calls into OpenAI-compatible API requests and returns the response. It does not execute code, access the filesystem, or modify any external state on its own.

## What Claude Can Do (via MCP tools)

| Tool | Action | Side Effects |
|------|--------|--------------|
| `openclaw_chat` | Send a text message to OpenClaw, receive a text response | None — read-only query |
| `openclaw_status` | Check if the OpenClaw gateway is reachable | None — health check only |
| `openclaw_chat_async` | Queue a message for async processing, receive a task ID | Creates an in-memory task |
| `openclaw_task_status` | Check the status of an async task by ID | None — read-only |
| `openclaw_task_list` | List all async tasks and their statuses | None — read-only |
| `openclaw_task_cancel` | Cancel a pending async task by ID | Removes an in-memory task |

**Key point:** All tools either read data or send text messages to OpenClaw. The MCP server itself has **no write access** to any filesystem, database, or external service beyond the OpenClaw gateway.

## What Claude Cannot Do

- **Execute shell commands** — the server has no shell execution capability
- **Read or write files** — no filesystem access (Docker enforces `read_only: true`)
- **Access the network** — can only reach the configured OpenClaw gateway URL
- **Modify server configuration** — environment variables are set at startup, not changeable at runtime
- **Bypass authentication** — OAuth tokens are validated per-request when auth is enabled
- **Access other users' sessions** — sessions are isolated by MCP session ID

## Trust Boundaries

### Boundary 1: Claude <-> MCP Server

- **stdio transport (local):** Trusted — communication stays on the local machine. No authentication required.
- **HTTP transport (remote):** Untrusted network — requires OAuth 2.1 authentication, HTTPS (via reverse proxy), and CORS restrictions.

### Boundary 2: MCP Server <-> OpenClaw Gateway

- The MCP server authenticates to the gateway using a Bearer token (`OPENCLAW_GATEWAY_TOKEN`).
- The server validates the gateway URL at startup and blocks requests to private IP ranges (SSRF protection).
- Responses from the gateway are size-limited (10 MB max) and parsed as JSON — no raw pass-through.

### Boundary 3: User <-> Claude

- Claude decides which MCP tools to call and with what arguments. The MCP server validates all tool inputs (string length, type, format) but **cannot control Claude's intent**.
- If OpenClaw can perform actions with real-world consequences (e.g., sending emails, modifying data), those consequences are ultimately triggered by Claude's tool calls through the gateway.

## Attack Surfaces

### 1. Malicious MCP Tool Input

**Risk:** Crafted tool arguments could exploit the OpenClaw gateway.

**Mitigations:**
- All tool inputs are validated: type checks, string length limits, control character rejection
- The MCP server does not interpret message content — it passes validated strings to the gateway

### 2. Compromised OpenClaw Gateway

**Risk:** A compromised gateway could return malicious responses.

**Mitigations:**
- Response size limit (10 MB) prevents memory exhaustion
- Responses are parsed as JSON — no script execution
- Error messages from the gateway are sanitized before being returned to Claude

### 3. Network-Level Attacks (HTTP transport)

**Risk:** Man-in-the-middle, replay attacks, unauthorized access.

**Mitigations:**
- OAuth 2.1 with client credentials (required for production)
- HTTPS via reverse proxy (Caddy or nginx)
- CORS restricted to configured origins (default: `https://claude.ai`)
- DNS rebinding protection via MCP SDK's Express middleware

### 4. Server-Side Request Forgery (SSRF)

**Risk:** Attacker could trick the server into making requests to internal services.

**Mitigations:**
- Only one outbound destination: the configured `OPENCLAW_URL`
- Private IP ranges are blocked at the client level
- URL is set at startup via environment variable, not controllable via tool input

### 5. Denial of Service

**Risk:** Resource exhaustion through excessive requests or large payloads.

**Mitigations:**
- Request timeout: 30 seconds per gateway call
- Response size limit: 10 MB
- Docker memory limit: 256 MB (configurable)
- Async task queue is in-memory with bounded processing

## Production Recommendations

If you expose this server beyond localhost:

1. **Enable OAuth 2.1** — set `AUTH_ENABLED=true` with strong client credentials
2. **Use HTTPS** — terminate TLS at a reverse proxy (Caddy recommended)
3. **Restrict CORS** — set `CORS_ORIGINS=https://claude.ai` (or your specific origin)
4. **Run in Docker** — use the provided `docker-compose.yml` with `read_only` and `no-new-privileges`
5. **Review gateway permissions** — the MCP server is only as safe as what the OpenClaw gateway allows. If OpenClaw can perform destructive actions, consider adding tool allowlists and human approval on the gateway side
6. **Monitor logs** — see [Logging](./logging.md) for what gets logged and where
