import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { SERVER_NAME, SERVER_VERSION } from './config/constants.js';
import { log, logError, setDebugEnabled } from './utils/logger.js';
import { parseArguments } from './cli.js';
import { InstanceRegistry } from './openclaw/registry.js';
import { createMcpServer, type ToolRegistrationDeps } from './server/mcp-server.js';
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

  if (args.transport === 'sse') {
    logError(
      'The legacy SSE transport was removed in v2.0. Use --transport http (Streamable HTTP).'
    );
    process.exit(1);
  }

  if (args.transport === 'http') {
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
    // stdio transport (default). serveStdio owns protocol-era negotiation:
    // 2026-07-28 clients get the modern stateless protocol, 2025-era clients
    // are served through the SDK's legacy path.
    // serveStdio reports failures through onerror rather than throwing, and it
    // uses the same channel for a failed start and for recoverable per-message
    // errors. We can't tell them apart here, so we log rather than exit — a
    // malformed line from the client must not kill the server.
    const handle = serveStdio(() => createMcpServer(deps), {
      onerror: (error) => logError('stdio transport error', error),
    });

    const shutdownStdio = () => {
      void Promise.resolve(handle.close?.()).finally(() => process.exit(0));
    };
    (process as NodeJS.Process).on('SIGTERM', shutdownStdio);
    (process as NodeJS.Process).on('SIGINT', shutdownStdio);

    log('OpenClaw MCP server running on stdio');
  }
}

main().catch((error) => {
  logError('Fatal error', error);
  process.exit(1);
});
