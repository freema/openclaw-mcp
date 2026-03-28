# Logging

## Overview

The MCP server logs operational events to **stderr** using the `[openclaw-mcp]` prefix. Stderr is used (instead of stdout) because the stdio MCP transport uses stdout for protocol messages.

## Log Levels

| Level | Prefix | When |
|-------|--------|------|
| Info | `[openclaw-mcp]` | Normal operations — startup, connections, shutdown |
| Error | `[openclaw-mcp] ERROR:` | Failures — connection errors, invalid config, fatal errors |
| Debug | `[openclaw-mcp] DEBUG:` | Verbose output — only when `DEBUG=true` or `NODE_ENV=development` |

## What Gets Logged

### Startup

- Server name and version
- OpenClaw gateway URL (host only, no tokens)
- Transport type (stdio or SSE)
- Whether a gateway token is configured (yes/no, not the token itself)
- OAuth client ID (when auth is enabled)
- Listening address and port (SSE mode)
- CORS origins configuration

### Connections (SSE/HTTP transport)

- SSE session connected/disconnected (with session ID)
- Streamable HTTP session initialized/closed (with session ID)

### Errors

- Gateway connection failures
- Request timeouts
- Invalid client configuration (missing secrets, bad client ID format)
- Session errors

### What Is NOT Logged (Info/Error levels)

- **Message content** — user messages and OpenClaw responses are never logged
- **Authentication tokens** — Bearer tokens, client secrets, gateway tokens
- **Request/response bodies** — only error messages, not full payloads
- **User-identifiable information** — no IPs, user agents, or personal data

### Debug Level (`DEBUG=true`)

> **Warning:** Debug mode is a diagnostic tool. It logs request and response payloads which may contain user message content. Do not enable in production under normal operation — use it only for active troubleshooting, then disable it.

When debug logging is enabled, the following **are** logged for troubleshooting:

- **Request bodies** — outgoing payloads sent to the gateway (truncated to 4096 chars)
- **Error response bodies** — full error responses from the gateway (truncated to 4096 chars)

Credentials are still redacted by the sanitization layer. Headers (including Authorization) are never logged, even in debug mode.

## Sensitive Data Redaction

The logger automatically redacts patterns that look like credentials:

- `Bearer <token>` -> `[REDACTED]`
- `api_key=<value>` -> `[REDACTED]`
- `token=<value>` -> `[REDACTED]`
- `secret=<value>` -> `[REDACTED]`
- `password=<value>` -> `[REDACTED]`

This is a safety net — the code avoids logging sensitive values in the first place, but the redaction layer catches accidental exposure.

## Log Destination

| Transport | Destination | Notes |
|-----------|-------------|-------|
| stdio | stderr | Cannot use stdout (reserved for MCP protocol) |
| SSE/HTTP | stderr | Same format, same destination |
| Docker | `docker logs openclaw-mcp` | stderr is captured by Docker's log driver |

## Docker Log Management

When running in Docker, logs are managed by the Docker log driver:

```bash
# View logs
docker logs openclaw-mcp

# Follow logs
docker logs -f openclaw-mcp

# Last 100 lines
docker logs --tail 100 openclaw-mcp
```

To configure log rotation in `docker-compose.yml`:

```yaml
services:
  mcp-bridge:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

## Enabling Debug Logs

Set either environment variable:

```bash
DEBUG=true        # Explicit debug flag
NODE_ENV=development  # Development mode
```

Debug logs include request/response bodies for troubleshooting (truncated to 4096 chars). Credentials are still redacted, and headers (including Authorization) are never logged.
