import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SERVER_NAME, SERVER_VERSION } from './config/constants.js';
import { log, logError } from './utils/logger.js';
import { parseArguments } from './cli.js';
import { InstanceRegistry } from './openclaw/registry.js';
import { createMcpServer, type ToolRegistrationDeps } from './server/tools-registration.js';
import { createSSEServer, type SSEServerConfig } from './server/sse.js';

// Parse CLI arguments
const args = parseArguments(SERVER_VERSION);

async function main() {
  // Create instance registry with full SSRF validation (including DNS resolution)
  const registry = await InstanceRegistry.create(args.instances);

  // Shared dependencies for tool registration
  const deps: ToolRegistrationDeps = {
    registry,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
  };
  log(`Starting ${SERVER_NAME} v${SERVER_VERSION}`);
  log(`Transport: ${args.transport}`);
  log(`Request timeout: ${args.timeout}ms`);

  // Log instance configuration
  for (const instance of registry.list()) {
    const defaultLabel = instance.isDefault ? ' (default)' : '';
    log(`Instance "${instance.name}": ${instance.url}${defaultLabel}`);
  }

  if (args.transport === 'sse') {
    const sseConfig: SSEServerConfig = {
      port: args.port,
      host: args.host,
      issuerUrl: args.issuerUrl,
    };

    // Enable OAuth when auth flag is set and client credentials are provided
    if (args.authEnabled && args.clientId) {
      // Validate client ID: 3-64 chars, alphanumeric + dashes + underscores only
      const clientIdRegex = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/;
      if (!clientIdRegex.test(args.clientId)) {
        logError(
          'MCP_CLIENT_ID is invalid. Must be 3-64 characters, alphanumeric/dashes/underscores, start with a letter or digit.'
        );
        process.exit(1);
      }

      if (!args.clientSecret || args.clientSecret.length < 32) {
        logError(
          'MCP_CLIENT_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32'
        );
        process.exit(1);
      }

      sseConfig.authConfig = {
        clientId: args.clientId,
        clientSecret: args.clientSecret,
        redirectUris: args.redirectUris,
      };
      log(`OAuth client ID: ${args.clientId}`);
      if (!args.redirectUris || args.redirectUris.length === 0) {
        logError(
          'AUTH_ENABLED=true but MCP_REDIRECT_URIS is not set. ' +
            'You must configure allowed redirect URIs in production to prevent open redirect attacks. ' +
            'Example: MCP_REDIRECT_URIS=https://claude.ai/oauth/callback'
        );
        process.exit(1);
      }
    } else if (args.authEnabled && !args.clientId) {
      logError('AUTH_ENABLED=true but MCP_CLIENT_ID is not set. Refusing to start without auth.');
      process.exit(1);
    }

    await createSSEServer(sseConfig, deps);
  } else {
    // stdio transport (default)
    const server = createMcpServer(deps);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('OpenClaw MCP server running on stdio');
  }
}

main().catch((error) => {
  logError('Fatal error', error);
  process.exit(1);
});
