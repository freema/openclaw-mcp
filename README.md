# OpenClaw MCP Server

[![npm version](https://badge.fury.io/js/openclaw-mcp.svg)](https://www.npmjs.com/package/openclaw-mcp)
[![CI](https://github.com/freema/openclaw-mcp/workflows/CI/badge.svg)](https://github.com/freema/openclaw-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Ffreema%2Fopenclaw--mcp-blue?logo=github)](https://github.com/freema/openclaw-mcp/pkgs/container/openclaw-mcp)

<a href="https://glama.ai/mcp/servers/@freema/openclaw-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@freema/openclaw-mcp/badge" />
</a>

🦞 A production-ready Model Context Protocol (MCP) server that bridges Claude (Desktop & Claude.ai) with [OpenClaw](https://github.com/openclaw/openclaw) AI assistant, enabling seamless AI-to-AI communication and task delegation.

## ✨ Key Features

- **🔒 Production Security**: OAuth 2.1 authentication, CORS protection, input validation
- **🐳 Docker-First**: Pre-built containers with security hardening
- **🚀 Dual Transport**: stdio (Claude Desktop) and SSE (Claude.ai) support  
- **⚡ Async Operations**: Queue long-running tasks with progress tracking
- **📊 Health Monitoring**: Built-in status checks and logging
- **🔧 Zero Config**: Works out-of-the-box with sensible defaults

## Demo

<p align="center">
  <img src="docs/assets/claude-ai-demo.gif" alt="OpenClaw MCP in Claude.ai" width="720" />
</p>

## Use Cases

**AI Assistant Orchestration**: Let Claude delegate complex tasks to OpenClaw, which can then spawn other tools (like Claude Code) to handle implementation details.

**Examples**:
- Claude analyzes a bug report → OpenClaw investigates the codebase → Claude Code applies the fix
- Claude designs a feature → OpenClaw breaks it into tasks → Multiple AI agents collaborate on implementation
- Claude reviews code → OpenClaw runs automated tests → Claude summarizes results

**Think of it as your AI assistant managing other AI assistants.**

## 💡 Real-World Examples

### Code Review Workflow
```
1. Developer: "Review this PR for security issues"
2. Claude: Analyzes the diff, identifies potential issues
3. Claude → OpenClaw: "Perform deep security analysis of this authentication code"
4. OpenClaw: Runs SAST tools, reviews patterns, generates detailed report
5. Claude: Synthesizes findings into actionable recommendations
```

### Debugging Pipeline  
```
1. User: "My app is crashing with this error message"
2. Claude: Initial analysis suggests database connection issue
3. Claude → OpenClaw (async): "Investigate database connectivity patterns in codebase"
4. OpenClaw: Searches codebase, analyzes connection pooling, checks configurations
5. Claude: Receives analysis, suggests specific fix with code examples
```

### Feature Development
```
1. Product Manager: "Add OAuth login to our app"
2. Claude: Breaks down requirements, identifies components needed
3. Claude → OpenClaw: "Generate OAuth 2.0 implementation for Node.js/Express"
4. OpenClaw: Creates complete implementation with routes, middleware, tests
5. Claude: Reviews code, suggests improvements, explains integration steps
```

### Documentation Generation
```
1. User: "Generate API docs for this service"
2. Claude → OpenClaw: "Analyze this codebase and extract API endpoints"  
3. OpenClaw: Scans code, identifies routes, parameters, responses
4. Claude: Formats findings into OpenAPI spec, adds examples and descriptions
```

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
      - AUTH_ENABLED=true
      - MCP_CLIENT_ID=openclaw
      - MCP_CLIENT_SECRET=${MCP_CLIENT_SECRET}
      - MCP_ISSUER_URL=${MCP_ISSUER_URL:-}
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

Then in Claude.ai add a custom MCP connector pointing to your server with `MCP_CLIENT_ID=openclaw` and your `MCP_CLIENT_SECRET`.

> **Tips:**  
> • Pin a specific version instead of `latest` for production: `ghcr.io/freema/openclaw-mcp:1.1.0`  
> • Test connectivity: `curl https://your-domain.com/health` should return 200  
> • If auth fails, verify `MCP_ISSUER_URL` matches your public domain exactly

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
        "OPENCLAW_GATEWAY_TOKEN": "your-gateway-token"
      }
    }
  }
}
```

> **Troubleshooting:**  
> • Claude Desktop config location: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)  
> • Test OpenClaw first: `curl http://localhost:18789/v1/models`  
> • Check logs in Claude Desktop → Settings → Developer Tools

### Remote (Claude.ai) without Docker

```bash
AUTH_ENABLED=true MCP_CLIENT_ID=openclaw MCP_CLIENT_SECRET=your-secret \
  MCP_ISSUER_URL=https://mcp.your-domain.com \
  CORS_ORIGINS=https://claude.ai OPENCLAW_GATEWAY_TOKEN=your-gateway-token \
  npx openclaw-mcp --transport sse --port 3000
```

> **Important:** When running behind a reverse proxy (Caddy, nginx, etc.), you **must** set `MCP_ISSUER_URL` (or `--issuer-url`) to your public HTTPS URL. Without this, OAuth metadata will advertise `http://localhost:3000` and clients will fail to authenticate.

> **Quick Validation:**  
> • OAuth endpoint: `curl https://your-domain.com/.well-known/oauth-authorization-server`  
> • Server health: `curl https://your-domain.com/health`  
> • Enable debug logging: `DEBUG=* npx openclaw-mcp ...`

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

## 🛠️ Available Tools

### Sync Tools (Immediate Response)

| Tool | Description | Example Use Case |
|------|-------------|------------------|
| `openclaw_chat` | Send messages to OpenClaw and get immediate responses | Quick questions, simple tasks |
| `openclaw_status` | Check OpenClaw gateway health and connectivity | Health checks, debugging |

**Example**:
```
User: "Ask OpenClaw to explain this error message"
Claude: Uses openclaw_chat → Gets explanation → Responds immediately
```

### Async Tools (Long-running Operations)

| Tool | Description | Best For |
|------|-------------|----------|
| `openclaw_chat_async` | Queue a message, get task_id immediately | Complex analysis, code generation |
| `openclaw_task_status` | Check task progress and retrieve results | Monitoring long tasks |
| `openclaw_task_list` | List all tasks with filtering options | Task management, cleanup |
| `openclaw_task_cancel` | Cancel a pending or running task | Stopping unwanted operations |

**Example Workflow**:
```
1. User: "Have OpenClaw refactor this entire codebase"
2. Claude: Uses openclaw_chat_async → Gets task_id: abc123
3. Claude: Periodically uses openclaw_task_status(abc123) → Shows progress
4. Claude: Task completes → Presents final results to user
```

### When to Use Async vs Sync

- **Use Sync** for: Quick questions, status checks, simple requests
- **Use Async** for: Code generation, file analysis, complex reasoning, anything >30 seconds

## 🔧 Troubleshooting

### Common Issues

**MCP Server Not Connecting**
```bash
# Check if OpenClaw gateway is running
curl http://localhost:18789/v1/models

# Verify MCP server is accessible
npx openclaw-mcp --help
```

**Authentication Failures (Claude.ai)**
```bash
# Generate new client secret
export MCP_CLIENT_SECRET=$(openssl rand -hex 32)

# Verify issuer URL matches your public domain
echo $MCP_ISSUER_URL  # Should be https://your-domain.com, not localhost
```

**CORS Errors**
```bash
# Set CORS origins explicitly
export CORS_ORIGINS=https://claude.ai
```

**Connection Timeouts**
- Increase `OPENCLAW_TIMEOUT` (default: 30000ms)
- Check network connectivity between MCP server and OpenClaw
- Verify firewall rules allow traffic on port 18789

**Docker Issues**
```bash
# Check container logs
docker logs openclaw-mcp

# Verify host networking
docker exec openclaw-mcp curl http://host.docker.internal:18789/health
```

### Debug Mode

Enable verbose logging:
```bash
DEBUG=* npx openclaw-mcp
```

### Getting Help

1. Check the [logs](docs/logging.md) for error details
2. Review [configuration options](docs/configuration.md)  
3. Open an issue with logs and config (redact secrets!)

## Documentation

- [Installation](docs/installation.md) — Setup for Claude Desktop & Claude.ai
- [Configuration](docs/configuration.md) — Environment variables & options
- [Deployment](docs/deployment.md) — Docker & production setup
- [Threat Model](docs/threat-model.md) — What Claude can/can't trigger, trust boundaries & attack surfaces
- [Logging](docs/logging.md) — What gets logged, where, and what is never logged
- [Development](docs/development.md) — Contributing & adding tools
- [Security](SECURITY.md) — Security policy & best practices

## ⚡ Performance & Limitations

### Performance Characteristics

- **Sync Tools**: ~100-500ms response time (depends on OpenClaw processing)
- **Async Tools**: Immediate task queuing, actual processing time varies
- **Concurrent Requests**: Supports multiple simultaneous Claude connections
- **Memory Usage**: ~50MB base + ~10MB per active async task
- **Docker Overhead**: +20-30MB container overhead

### Rate Limits

- **Default**: 10 requests/second per client
- **Configurable**: Set `RATE_LIMIT_RPM` environment variable
- **Async Tasks**: Max 50 concurrent tasks (configurable via `MAX_CONCURRENT_TASKS`)

### Known Limitations

- **OpenClaw Dependency**: Requires OpenClaw gateway to be running and accessible
- **Network Latency**: Performance affected by network distance to OpenClaw
- **Memory Bounded**: Large async task results consume server memory until retrieved
- **Single Gateway**: Currently supports one OpenClaw instance per MCP server
- **Task Persistence**: Async tasks lost on server restart (use sync for critical operations)

### Scaling Considerations

- **Horizontal**: Run multiple MCP server instances behind a load balancer
- **Vertical**: Increase container resources for more concurrent tasks
- **Async Task Cleanup**: Configure `TASK_CLEANUP_INTERVAL` to prevent memory leaks

## 🔒 Security

### Production Checklist

✅ **Authentication** - OAuth 2.1 enabled (`AUTH_ENABLED=true`)  
✅ **HTTPS** - TLS termination at reverse proxy  
✅ **CORS** - Restrict origins to trusted domains  
✅ **Secrets** - Generate strong client secrets  
✅ **Container** - Run via Docker with security hardening  
✅ **Network** - Isolate from public networks  
✅ **Monitoring** - Enable audit logging  

### Quick Setup

```bash
# 1. Generate secure credentials
export MCP_CLIENT_SECRET=$(openssl rand -hex 32)
export OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# 2. Enable authentication
export AUTH_ENABLED=true
export MCP_CLIENT_ID=openclaw

# 3. Configure CORS
export CORS_ORIGINS=https://claude.ai,https://your-domain.com

# 4. Set public URL for OAuth
export MCP_ISSUER_URL=https://mcp.your-domain.com
```

### Security Model

- **Authentication**: OAuth 2.1 with Bearer tokens
- **Authorization**: Client-based access control
- **Input Validation**: All tool inputs sanitized and validated
- **Error Handling**: No sensitive data in error responses
- **Audit Logging**: All requests logged with client identification
- **Container Security**: Read-only filesystem, no-new-privileges, non-root user

### Threat Mitigation

| Threat | Mitigation |
|--------|-----------|
| Unauthorized access | OAuth 2.1 + CORS restrictions |
| Injection attacks | Input validation + parameterized queries |
| Data exfiltration | Audit logging + network isolation |
| Container escape | Security-hardened Docker configuration |
| Credential exposure | Environment variables + secrets management |

See [Threat Model](docs/threat-model.md) and [Security Policy](SECURITY.md) for complete details.

## ❓ FAQ

**Q: What's the difference between this and just using OpenClaw directly?**  
A: This MCP server enables Claude to use OpenClaw as a tool, creating an AI orchestration layer. Claude can intelligently decide when to delegate tasks to OpenClaw and coordinate between multiple AI systems.

**Q: Do I need Docker to run this?**  
A: Not for local Claude Desktop usage, but Docker is strongly recommended for production deployments with Claude.ai due to security and reliability benefits.

**Q: Can I use this with multiple OpenClaw instances?**  
A: Currently, each MCP server connects to one OpenClaw gateway. For multiple instances, deploy multiple MCP servers with different configurations.

**Q: What happens if OpenClaw goes down?**  
A: The MCP server will return connection errors. Sync tools fail immediately; async tasks remain queued and will retry when OpenClaw is available.

**Q: How much does this impact performance?**  
A: Minimal overhead (~100-200ms per request). The bottleneck is typically OpenClaw processing, not the MCP bridge.

**Q: Is this secure for production use?**  
A: Yes, when properly configured with OAuth 2.1, HTTPS, CORS restrictions, and Docker security hardening. See the security documentation for details.

**Q: Can I customize the available tools?**  
A: Yes! See [Development](docs/development.md) for adding custom tools. The codebase is modular and extensible.

**Q: What's logged and where?**  
A: See [Logging](docs/logging.md) for details. In summary: requests, responses, errors, but never credentials or sensitive data.

**Q: How do I update to a new version?**  
A: For Docker: pull latest image and restart container. For npm: `npm update -g openclaw-mcp`.

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
