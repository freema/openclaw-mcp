# Development

## Setup

```bash
# Clone the repository
git clone https://github.com/freema/openclaw-mcp
cd openclaw-mcp

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

## Available Scripts

```bash
# Run in development mode (watch)
npm run dev

# Type check
npm run typecheck

# Lint
npm run lint

# Format code
npm run format

# Build for production
npm run build

# Run tests
npm run test

# Test with MCP Inspector
npm run inspector
```

## Project Structure

```
src/
├── auth/           # OAuth authentication
├── config/         # Constants and configuration
├── mcp/
│   └── tools/      # MCP tool implementations
├── openclaw/       # OpenClaw API client
├── server/         # HTTP server (for remote access)
├── utils/          # Logging, errors, helpers
├── cli.ts          # CLI argument parsing
└── index.ts        # Main entry point
```

## Adding a New Tool

1. Create tool file in `src/mcp/tools/`:

```typescript
// src/mcp/tools/my-tool.ts
import { OpenClawClient } from '../../openclaw/client.js';
import { successResponse, errorResponse } from '../../utils/response-helpers.js';

export const myToolDefinition = {
  name: 'openclaw_my_tool',
  description: 'Description of what this tool does',
  inputSchema: {
    type: 'object' as const,
    properties: {
      param1: { type: 'string', description: 'Parameter description' },
    },
    required: ['param1'],
  },
};

export async function handleMyTool(client: OpenClawClient, input: unknown) {
  // Implementation
  return successResponse('Result');
}
```

2. Export from `src/mcp/tools/index.ts`
3. Register in `src/server/tools-registration.ts` toolHandlers map

## Testing

```bash
# Run all tests
npm run test

# Run with coverage
npm run test:coverage

# Run specific test
npm run test -- --grep "tool name"
```
