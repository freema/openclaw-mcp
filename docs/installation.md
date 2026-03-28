# Installation

## NPM Install

```bash
npm install -g openclaw-mcp
```

Or run directly with npx:

```bash
npx openclaw-mcp
```

## Claude Desktop Configuration

For local use with Claude Desktop, use stdio transport (default):

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

**Config file locations:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

## Claude.ai (Remote Access)

For remote access via Claude.ai, deploy with SSE transport and OAuth 2.1 authentication.

### 1. Generate credentials

```bash
export MCP_CLIENT_ID=openclaw
export MCP_CLIENT_SECRET=$(openssl rand -hex 32)
echo "Client ID: $MCP_CLIENT_ID"
echo "Client Secret: $MCP_CLIENT_SECRET"
```

### 2. Start server

```bash
AUTH_ENABLED=true \
MCP_CLIENT_ID=openclaw \
MCP_CLIENT_SECRET=your-secret \
CORS_ORIGINS=https://claude.ai \
OPENCLAW_GATEWAY_TOKEN=your-gateway-token \
openclaw-mcp --transport sse --port 3000
```

### 3. Add to Claude.ai

In Claude.ai, go to **Settings** → **Integrations** → **Add custom connector**:

- **Name**: `OpenClaw`
- **URL**: `https://mcp.your-domain.com/mcp`
- **Client ID**: `openclaw` (or your `MCP_CLIENT_ID`)
- **Client Secret**: your `MCP_CLIENT_SECRET` value

Claude.ai will automatically perform the OAuth 2.1 flow to connect.

### 4. MCP Inspector (for testing)

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector web UI:
1. Set **URL** to `http://localhost:3000/mcp`
2. Set **Transport** to `Streamable HTTP`
3. Enter your **Client ID** and **Client Secret** (same as `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET`)
4. Click **Connect** — the Inspector will perform the OAuth 2.1 flow automatically

## CLI Options

```bash
openclaw-mcp --help

Options:
  --openclaw-url, -u  OpenClaw gateway URL     [default: "http://127.0.0.1:18789"]
  --gateway-token     Bearer token for gateway [default: none]
  --model, -m         Model name for chat      [default: "openclaw"]
  --transport, -t     Transport mode           [choices: "stdio", "sse"] [default: "stdio"]
  --port, -p          Port for SSE server      [default: 3000]
  --host              Host for SSE server      [default: "0.0.0.0"]
  --debug             Enable debug logging     [default: false]
  --auth              Enable OAuth             [default: false]
  --client-id         MCP OAuth client ID      [env: MCP_CLIENT_ID]
  --client-secret     MCP OAuth client secret  [env: MCP_CLIENT_SECRET]
  --issuer-url        OAuth issuer URL         [env: MCP_ISSUER_URL]
  --redirect-uris     Allowed redirect URIs    [env: MCP_REDIRECT_URIS]
  --version           Show version number
  --help              Show help
```

> **Note:** `--issuer-url` is required when running behind a reverse proxy (Caddy, nginx, etc.) so that OAuth metadata endpoints return the correct public HTTPS URL instead of `http://localhost:3000`.
