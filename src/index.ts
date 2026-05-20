import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SERVER_NAME, SERVER_VERSION } from './config/constants.js';
import { log, logError, setDebugEnabled } from './utils/logger.js';
import { parseArguments } from './cli.js';
import { InstanceRegistry } from './openclaw/registry.js';
import { createMcpServer, type ToolRegistrationDeps } from './server/tools-registration.js';
import { createSSEServer, parseTrustProxy, type SSEServerConfig } from './server/sse.js';

// Parse CLI arguments
const args = parseArguments(SERVER_VERSION);

// Enable debug logging if requested
setDebugEnabled(args.debug);

// Validate model name
const trimmedModel = args.model.trim();
if (!trimmedModel) {
  logError('OPENCLAW_MODEL / --model must be a non-empty string. Default is "openclaw".');
  process.exit(1);
}
args.model = trimmedModel;

// Create instance registry (single or multi-instance)
const registry = new InstanceRegistry(args.instances, args.model);

// Shared dependencies for tool registration
const deps: ToolRegistrationDeps = {
  registry,
  serverName: SERVER_NAME,
  serverVersion: SERVER_VERSION,
};

async function main() {
  log(`Starting ${SERVER_NAME} v${SERVER_VERSION}`);
  log(`Model: ${args.model}`);
  log(`Transport: ${args.transport}`);
  log(`Request timeout: ${args.timeout}ms`);
  if (args.debug) {
    log('Debug logging: enabled');
  }

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
      trustProxy: parseTrustProxy(args.trustProxy),
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
        allowDynamicRegistration: args.allowDcr,
      };
      log(`OAuth client ID: ${args.clientId}`);
      if (!args.redirectUris || args.redirectUris.length === 0) {
        log(
          'WARNING: MCP_REDIRECT_URIS not set — any redirect_uri will be accepted. ' +
            'Set MCP_REDIRECT_URIS for production.'
        );
      }
      if (args.allowDcr) {
        // DCR + auto-approve = any reachable client can self-register and obtain
        // a bearer token without user interaction. Refuse to bind non-loopback
        // hosts unless the operator explicitly opts in via the escape hatch.
        const isLoopback =
          args.host === '127.0.0.1' || args.host === 'localhost' || args.host === '::1';
        const publicOptIn = process.env.MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC === 'true';
        if (!isLoopback && !publicOptIn) {
          logError(
            `MCP_DANGEROUSLY_ALLOW_DCR=true is set but HOST="${args.host}" is not loopback. ` +
              'Dynamic Client Registration combined with a publicly reachable bind allows ' +
              'anyone on the network to obtain a token. Bind to 127.0.0.1, or set ' +
              'MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC=true to override. Refusing to start.'
          );
          process.exit(1);
        }
        log(
          'WARNING: MCP_DANGEROUSLY_ALLOW_DCR is enabled — OAuth Dynamic Client Registration is open. ' +
            'Any client that can reach this server may self-register and obtain tokens. ' +
            'Use for local development only.'
        );
        if (publicOptIn) {
          log(
            'WARNING: MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC=true — DCR is exposed on a non-loopback bind. ' +
              'You have explicitly accepted the risk.'
          );
        }
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
