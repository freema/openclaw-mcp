# OpenClaw MCP Server

## Project Overview
OpenClaw MCP (Model Context Protocol) server provides a bridge between Claude (Desktop & Claude.ai) and the OpenClaw AI assistant. It implements the MCP specification to expose OpenClaw capabilities as tools that Claude can invoke.

## Security Policy (CRITICAL)
This is a **security-critical** MCP server. Follow these rules:

### Docker-First Deployment (MANDATORY)
- Users **MUST** run this server via Docker in production
- Never run directly on bare metal in production environments
- Docker provides: process isolation, network segmentation, resource limits, reproducible builds
- Use the provided `docker-compose.yml` for the complete stack

### Authentication
- OAuth 2.1 **MUST** be enabled in production (`AUTH_ENABLED=true`)
- Set `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET` env vars
- Generate secrets with: `openssl rand -hex 32`
- Never commit secrets to the repository
- Uses MCP SDK's built-in OAuth server (`mcpAuthRouter` + `requireBearerAuth`)

### Input Validation
- All MCP tool inputs MUST be validated before processing
- Validate string lengths, types, and formats
- Never pass unsanitized input to system calls or APIs

### Error Handling
- Never expose stack traces, internal paths, or credentials in error responses
- Log errors server-side, return generic messages to clients

## Architecture
```
Claude Desktop/Claude.ai
    ↕ (MCP Protocol - stdio or Streamable HTTP)
OpenClaw MCP Server (this project)
    ↕ (OpenAI-compatible REST API: POST /v1/chat/completions)
OpenClaw Gateway (http://localhost:18789)
```

### Gateway API
The OpenClaw gateway exposes an **OpenAI-compatible** endpoint at `POST /v1/chat/completions`.
Authentication uses a Bearer token (`OPENCLAW_GATEWAY_TOKEN`).

### Transports
- **stdio** - For local Claude Desktop integration (default)
- **HTTP** - For remote Claude.ai integration (Streamable HTTP primary, legacy SSE kept for backward compat; requires OAuth + HTTPS)

### Tools
| Tool | Type | Description |
|------|------|-------------|
| openclaw_chat | sync | Send message to OpenClaw |
| openclaw_status | sync | Health check |
| openclaw_chat_async | async | Queue message, get task_id |
| openclaw_task_status | async | Check task progress |
| openclaw_task_list | async | List all tasks |
| openclaw_task_cancel | async | Cancel pending task |

## Development

### Commands
```bash
npm run dev          # Watch mode (tsx)
npm run build        # Production build (tsup)
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier formatting
npm run test         # Vitest (watch mode)
npm run test:run     # Vitest (single run)
npm run check:all    # Full validation pipeline
```

### Tech Stack
- TypeScript (ES2022 target, ESM modules)
- Node.js >=20
- Build: tsup (bundles to single dist/index.js)
- Test: vitest
- Lint: eslint + prettier

### File Structure
```
src/
├── index.ts              # Entry point, MCP server setup
├── cli.ts                # CLI argument parsing (yargs)
├── auth/provider.ts      # OAuth 2.1 server provider (MCP SDK)
├── config/constants.ts   # Server constants
├── mcp/tools/            # MCP tool definitions & handlers
├── mcp/tasks/            # Async task manager
├── openclaw/client.ts    # OpenClaw API client (OpenAI-compatible)
├── openclaw/types.ts     # TypeScript type definitions
├── server/http.ts        # HTTP transport (remote access)
└── utils/                # Logger, errors, response helpers
```

## Conventions
- ESM imports with .js extensions (required for ESM compatibility)
- Underscore prefix for unused variables (_var)
- Single quotes, semicolons, 2-space indent, 100 char width
- Custom error classes extend OpenClawError
- All async operations use async/await (no raw promises)

## Docker Deployment (Required for Production)
```bash
# Quick start
docker compose up -d

# With custom config
cp .env.example .env
# Edit .env with your settings
docker compose up -d
```

See `docs/deployment.md` for full production setup including TLS, OAuth, and monitoring.
