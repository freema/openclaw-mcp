# Security Policy

## 🔐 Security Considerations

OpenClaw MCP Bridge provides access to your AI assistant. **Proper security is critical.**

### Threat Model

| Threat | Risk | Mitigation |
|--------|------|------------|
| Unauthorized access | High | OAuth 2.1 is mandatory for the HTTP transport; port published on loopback behind a reverse proxy |
| Prompt injection into the OpenClaw agent | High | Route the bridge to a least-privilege agent (`OPENCLAW_AGENT_ID`), see below |
| Token theft | High | HTTPS only, 1-hour access tokens, rotating refresh tokens, `MCP_REDIRECT_URIS` allow-list |
| Man-in-the-middle | High | TLS terminated at the reverse proxy |
| Denial of service | Medium | Request body limit (4 MiB, enforced after authentication), SDK rate limits on the OAuth endpoints, container memory limit |
| Information disclosure | Medium | JSON error responses without stack traces, credentials redacted from logs |

### Security Checklist

#### ✅ Required for Production

- [ ] Configure OAuth (`MCP_CLIENT_ID` + `MCP_CLIENT_SECRET`; the HTTP transport refuses to start without them since 1.8.0)
- [ ] Generate the client secret with `openssl rand -hex 32` (32 characters minimum)
- [ ] Use HTTPS (deploy behind a reverse proxy with TLS) and keep the bridge port off the public interface
- [ ] Set `MCP_REDIRECT_URIS` to the callbacks of the clients you actually use
- [ ] Point the bridge at a least-privilege OpenClaw agent (`OPENCLAW_AGENT_ID`)
- [ ] Keep dependencies updated

#### ✅ Recommended

- [ ] Leave Dynamic Client Registration off (the default)
- [ ] Leave CORS off unless a browser client needs it, then list explicit origins
- [ ] Add rate limiting at the reverse proxy
- [ ] Run the container read-only with `cap_drop: [ALL]` and `no-new-privileges` (the provided `docker-compose.yml` does)
- [ ] Monitor the logs for suspicious activity

### Authentication

**stdio transport** has no authentication: the server is a child process of the
MCP client on the same machine, and whoever can start it already has the
gateway token.

**HTTP transport** uses the OAuth 2.1 authorization server built into the MCP
SDK (authorization code + PKCE). It is mandatory: without credentials the
server refuses to start.

```bash
MCP_CLIENT_ID=openclaw
MCP_CLIENT_SECRET=$(openssl rand -hex 32)
# Recommended: only deliver authorization codes to callbacks you trust
MCP_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback
```

How it works, and what it does not do:

- **One pre-configured confidential client.** `MCP_CLIENT_ID` (3–64 chars) and
  `MCP_CLIENT_SECRET` (at least 32 chars) are the credentials you enter in the
  MCP client, e.g. the Claude.ai connector. The secret is checked at `/token`.
- **No login or consent screen.** `/authorize` approves the pre-configured
  client automatically. The client secret is the actual gate — treat it like a
  password, and anyone who has it has full access to the bridge.
- **Tokens are opaque and in memory.** Access tokens live for 1 hour, refresh
  tokens for 24 hours and are rotated on use; `/revoke` is supported. A restart
  drops all tokens and clients re-authenticate.
- **Redirect URIs.** When `MCP_REDIRECT_URIS` is unset any `redirect_uri` is
  accepted and the server logs a warning at startup. Set it in production.
- **Dynamic Client Registration is off.** `MCP_DANGEROUSLY_ALLOW_DCR=true`
  enables it for clients that need it (Cursor, Windsurf). Combined with the
  automatic approval it lets anyone who can reach the server obtain a token, so
  the server refuses to start with DCR on a non-loopback bind unless
  `MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC=true` is also set.
- **No auth at all** is only possible with the explicit
  `MCP_DANGEROUSLY_DISABLE_AUTH=true`, for setups where a proxy in front
  authenticates every request.
- **Not supported:** external identity providers, token introspection and
  static API keys. If you need SSO, put an authenticating proxy in front.

The bridge authenticates to the OpenClaw gateway with a separate bearer token,
`OPENCLAW_GATEWAY_TOKEN`.

See [Configuration](docs/configuration.md#authentication-oauth-21) for the full
reference.

### Prompt Injection and the OpenClaw Agent

The bridge forwards text to an OpenClaw agent and returns its answer. It cannot
judge what that text makes the agent do. Text that reaches Claude from a web
page, an email or a document can end up in an `openclaw_chat` call, and if the
agent behind the bridge can run shell commands, write files or send messages,
so can that text. This is the largest real-world risk of running the bridge,
and authentication does not help against it: the request comes from your own,
correctly authenticated Claude session.

**Do not connect the bridge to your main, fully privileged agent.** Create a
dedicated OpenClaw agent for it with only the tools it needs, sandboxed, and
select it with `OPENCLAW_AGENT_ID` (or `agentId` per instance):

```bash
OPENCLAW_AGENT_ID=mcp-bridge
```

On the OpenClaw side, deny that agent `exec`/`process` and the file-writing
tools unless you need them, and run it sandboxed — see OpenClaw's
[multi-agent sandbox and tools](https://docs.openclaw.ai/tools/multi-agent-sandbox-tools)
documentation for the configuration keys of your OpenClaw version. An unknown
agent ID is rejected by the gateway with `400`, it does not fall back to the
default agent.

### Network Security

The bridge speaks plain HTTP and expects a TLS-terminating reverse proxy in
front. The provided `docker-compose.yml` publishes the port on `127.0.0.1`
only, so it is reachable through the proxy but not directly from the network.
Behind a proxy also set `MCP_ISSUER_URL` and `TRUST_PROXY` — see
[Deployment](docs/deployment.md#reverse-proxy-https).

#### Reverse Proxy Configuration (nginx)

```nginx
# In the http {} block:
limit_req_zone $binary_remote_addr zone=mcp:10m rate=10r/s;

server {
    listen 443 ssl http2;
    server_name mcp.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.3;

    # Rate limiting
    limit_req zone=mcp burst=20 nodelay;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Reporting Vulnerabilities

If you discover a security vulnerability, please **do not** open a public issue.

Instead, report it privately via GitHub Security Advisories:

👉 **[Report a vulnerability](https://github.com/freema/openclaw-mcp/security/advisories/new)**

When reporting, please include:

1. A clear description of the issue
2. Steps to reproduce
3. Impact assessment (if known)
4. Suggested fix (optional)

We will acknowledge receipt within 72 hours and aim to release a fix as soon as
possible. Please allow up to 90 days for a fix before public disclosure.

### Security Updates

We release security patches as soon as possible. Keep your installation updated:

```bash
npm update -g openclaw-mcp
```

Subscribe to security advisories on GitHub.
