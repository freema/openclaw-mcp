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

The MCP server is a thin proxy — it translates MCP tool calls into OpenAI-compatible API requests and returns the response. It does not execute code, access the filesystem, or modify any external state on its own. **The OpenClaw agent behind the gateway can**, which is why the agent's own permissions matter more than anything in this server (see [Prompt Injection](#1-prompt-injection-into-the-openclaw-agent)).

## What Claude Can Do (via MCP tools)

| Tool | Action | Side Effects |
|------|--------|--------------|
| `openclaw_chat` | Send a text message to OpenClaw, receive a text response | None in this server; the OpenClaw agent may act on the message with any tool it has |
| `openclaw_status` | Check if the OpenClaw gateway is reachable | None — health check only |
| `openclaw_chat_async` | Queue a message for async processing, receive a task ID | Creates an in-memory task; same as `openclaw_chat` once it runs |
| `openclaw_task_status` | Check the status of an async task by ID | None — read-only |
| `openclaw_task_list` | List all async tasks and their statuses | None — read-only |
| `openclaw_task_cancel` | Cancel a pending async task by ID | Removes an in-memory task |

**Key point:** All tools either read data or send text messages to OpenClaw. The MCP server itself has **no write access** to any filesystem, database, or external service beyond the OpenClaw gateway. What a message causes is decided by the OpenClaw agent that receives it.

## What Claude Cannot Do

- **Execute shell commands** — the server has no shell execution capability
- **Read or write files** — no filesystem access (Docker enforces `read_only: true`)
- **Access the network** — the server only talks to the configured OpenClaw gateway URL(s)
- **Modify server configuration** — environment variables are set at startup, not changeable at runtime
- **Bypass authentication** — OAuth tokens are validated per-request when auth is enabled
- **Access other clients' async tasks** — tasks are scoped to the authenticated OAuth client (to the connection when there is none)

## Trust Boundaries

### Boundary 1: Claude <-> MCP Server

- **stdio transport (local):** Trusted — communication stays on the local machine. No authentication required.
- **HTTP transport (remote):** Untrusted network — requires OAuth 2.1 authentication, HTTPS (via reverse proxy), and CORS restrictions.

### Boundary 2: MCP Server <-> OpenClaw Gateway

- The MCP server authenticates to the gateway using a Bearer token (`OPENCLAW_GATEWAY_TOKEN`).
- The gateway URL is fixed at startup (http/https only) and cannot be changed through tool input. It is not restricted to public addresses — a gateway on `127.0.0.1` or a private network is the normal case.
- Responses from the gateway are size-limited (10 MB max) and parsed as JSON — no raw pass-through.

### Boundary 3: User <-> Claude

- Claude decides which MCP tools to call and with what arguments. The MCP server validates all tool inputs (string length, type, format) but **cannot control Claude's intent**.
- If OpenClaw can perform actions with real-world consequences (e.g., sending emails, modifying data), those consequences are ultimately triggered by Claude's tool calls through the gateway.

## Attack Surfaces

### 1. Prompt Injection into the OpenClaw Agent

**Risk:** This is the most likely way the setup gets abused in practice. Claude reads untrusted content — web pages, emails, documents, tool results — and that content can contain instructions. If they make it into an `openclaw_chat` call, the OpenClaw agent treats them as a request from you and carries them out with every tool it has. With an agent that can run shell commands, that is remote code execution on the OpenClaw host. Authentication does not help: the call comes from your own, correctly authenticated Claude session, and the MCP server cannot tell a legitimate request from an injected one.

**Mitigations:**
- Route the bridge to a **dedicated, least-privilege OpenClaw agent** with `OPENCLAW_AGENT_ID` (or `agentId` per instance) instead of your main agent. Give it only the tools the integration needs, deny `exec`/`process` and file-writing tools unless required, and run it sandboxed — see OpenClaw's [multi-agent sandbox and tools](https://docs.openclaw.ai/tools/multi-agent-sandbox-tools) documentation
- Keep human approval on the OpenClaw side for anything destructive
- Review tool calls in Claude before approving them; do not auto-approve `openclaw_chat` in sessions that browse the web or read mail

### 2. Malicious MCP Tool Input

**Risk:** Crafted tool arguments could exploit the OpenClaw gateway.

**Mitigations:**
- All tool inputs are validated: type checks, string length limits, control character rejection
- The MCP server does not interpret message content — it passes validated strings to the gateway

### 3. Compromised OpenClaw Gateway

**Risk:** A compromised gateway could return malicious responses.

**Mitigations:**
- Response size limit (10 MB) prevents memory exhaustion
- Responses are parsed as JSON — no script execution
- Error messages from the gateway are sanitized before being returned to Claude

### 4. Network-Level Attacks (HTTP transport)

**Risk:** Man-in-the-middle, replay attacks, unauthorized access.

**Mitigations:**
- OAuth 2.1 (authorization code + PKCE) with a pre-configured client — mandatory, the server refuses to start without it
- HTTPS via reverse proxy (Caddy or nginx); the provided `docker-compose.yml` publishes the port on `127.0.0.1` only
- CORS is off by default; when enabled it is restricted to the configured origins
- DNS rebinding protection (Host header validation) on loopback binds and whenever `ALLOWED_HOSTS` is set

### 5. Server-Side Request Forgery (SSRF)

**Risk:** Attacker could trick the server into making requests to internal services.

**Mitigations:**
- The only outbound destinations are the configured gateway URLs (`OPENCLAW_URL` / `OPENCLAW_INSTANCES`)
- URLs are set at startup via environment variables, not controllable via tool input; a tool call can only pick an instance by name

### 6. Denial of Service

**Risk:** Resource exhaustion through excessive requests or large payloads.

**Mitigations:**
- Request body limit: 4 MiB on the MCP endpoints, read only after authentication; JSON-RPC batches capped at 100 messages
- Message length limit: 100,000 characters per tool call
- Request timeout per gateway call: `OPENCLAW_TIMEOUT_MS` (default 2 minutes)
- Response size limit: 10 MB
- The MCP SDK rate-limits the OAuth endpoints; add rate limiting for `/mcp` at the reverse proxy
- Docker memory limit: 256 MB (configurable)
- Async task queue is in-memory with bounded processing

## Production Recommendations

If you expose this server beyond localhost:

1. **Configure OAuth 2.1** — set `MCP_CLIENT_ID` and a strong `MCP_CLIENT_SECRET` (mandatory for the HTTP transport since 1.8.0; never use `MCP_DANGEROUSLY_DISABLE_AUTH` on a reachable bind)
2. **Use HTTPS** — terminate TLS at a reverse proxy (Caddy recommended)
3. **Use a least-privilege OpenClaw agent** — set `OPENCLAW_AGENT_ID` to a dedicated agent without shell access rather than your main agent. The MCP server is only as safe as what that agent is allowed to do; add tool allowlists and human approval on the OpenClaw side for anything destructive
4. **Restrict redirect URIs** — set `MCP_REDIRECT_URIS` to the callbacks of the clients you use
5. **Keep CORS off** unless a browser client needs it, then set `CORS_ORIGINS` to the specific origin
6. **Run in Docker** — use the provided `docker-compose.yml`: loopback-only port, `read_only`, `cap_drop: [ALL]` and `no-new-privileges`
7. **Monitor logs** — see [Logging](./logging.md) for what gets logged and where
