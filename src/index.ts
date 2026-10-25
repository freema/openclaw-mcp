import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SERVER_NAME, SERVER_VERSION } from './config/constants.js';
import { log, logError, setDebugEnabled } from './utils/logger.js';
import { parseArguments } from './cli.js';
import { InstanceRegistry } from './openclaw/registry.js';
import { createMcpServer, type ToolRegistrationDeps } from './server/tools-registration.js';
import {
  createHttpServer,
  parseTrustProxy,
  parseAllowedHosts,
  type HttpServerConfig,
} from './server/http.js';
import { resolveHttpAuth } from './server/http-auth.js';

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

  if (args.transport === 'sse' || args.transport === 'http') {
    if (args.transport === 'sse') {
      log('WARNING: --transport sse is deprecated; use --transport http instead');
    }
    const httpConfig: HttpServerConfig = {
      port: args.port,
      host: args.host,
      issuerUrl: args.issuerUrl,
      trustProxy: parseTrustProxy(args.trustProxy),
      allowedHosts: parseAllowedHosts(args.allowedHosts),
    };

    const auth = resolveHttpAuth({
      host: args.host,
      authEnabled: args.authEnabled,
      dangerouslyDisableAuth: args.dangerouslyDisableAuth,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      redirectUris: args.redirectUris,
      allowDcr: args.allowDcr,
      allowDcrPublic: process.env.MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC === 'true',
    });
    if (auth.ok === false) {
      logError(auth.error);
      process.exit(1);
    }
    auth.info.forEach((line) => log(line));
    auth.warnings.forEach((line) => log(line));
    httpConfig.authConfig = auth.authConfig;

    await createHttpServer(httpConfig, deps);
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
