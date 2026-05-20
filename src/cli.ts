import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { DEFAULT_OPENCLAW_URL, DEFAULT_MODEL } from './config/constants.js';
import type { InstanceConfig } from './openclaw/types.js';

export interface CliArgs {
  openclawUrl: string;
  gatewayToken: string | undefined;
  model: string;
  transport: 'stdio' | 'sse';
  port: number;
  host: string;
  timeout: number;
  debug: boolean;
  authEnabled: boolean;
  clientId: string | undefined;
  clientSecret: string | undefined;
  issuerUrl: string | undefined;
  redirectUris: string[] | undefined;
  allowDcr: boolean;
  trustProxy: string | undefined;
  instances: InstanceConfig[];
}

export function parseArguments(version: string): CliArgs {
  const argv = yargs(hideBin(process.argv))
    .version(version)
    .option('openclaw-url', {
      alias: 'u',
      type: 'string',
      description: 'OpenClaw gateway URL',
      default: process.env.OPENCLAW_URL || DEFAULT_OPENCLAW_URL,
    })
    .option('gateway-token', {
      type: 'string',
      description: 'Bearer token for OpenClaw gateway authentication',
      default: process.env.OPENCLAW_GATEWAY_TOKEN || undefined,
    })
    .option('model', {
      alias: 'm',
      type: 'string',
      description: 'Model name for chat completions',
      default: process.env.OPENCLAW_MODEL || DEFAULT_MODEL,
    })
    .option('transport', {
      alias: 't',
      type: 'string',
      choices: ['stdio', 'sse'] as const,
      description: 'Transport mode (stdio for local, sse for remote)',
      default: 'stdio',
    })
    .option('port', {
      alias: 'p',
      type: 'number',
      description: 'Port for SSE server',
      default: parseInt(process.env.PORT || '3000', 10),
    })
    .option('host', {
      type: 'string',
      description: 'Host for SSE server',
      default: process.env.HOST || '0.0.0.0',
    })
    .option('timeout', {
      type: 'number',
      description: 'Request timeout in milliseconds',
      default: parseInt(process.env.OPENCLAW_TIMEOUT_MS || '120000', 10),
    })
    .option('debug', {
      type: 'boolean',
      description: 'Enable debug logging',
      default: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
    })
    .option('auth', {
      type: 'boolean',
      description: 'Enable OAuth authentication (SSE mode)',
      default: process.env.AUTH_ENABLED === 'true' || process.env.OAUTH_ENABLED === 'true',
    })
    .option('client-id', {
      type: 'string',
      description: 'MCP OAuth client ID',
      default: process.env.MCP_CLIENT_ID || undefined,
    })
    .option('client-secret', {
      type: 'string',
      description: 'MCP OAuth client secret',
      default: process.env.MCP_CLIENT_SECRET || undefined,
    })
    .option('issuer-url', {
      type: 'string',
      description: 'OAuth issuer URL (for HTTPS behind reverse proxy)',
      default: process.env.MCP_ISSUER_URL || undefined,
    })
    .option('redirect-uris', {
      type: 'string',
      description: 'Allowed OAuth redirect URIs (comma-separated)',
      default: process.env.MCP_REDIRECT_URIS || undefined,
    })
    .option('allow-dcr', {
      type: 'boolean',
      description:
        'Allow OAuth Dynamic Client Registration (Cursor/Windsurf compatibility, dev-only)',
      default: process.env.MCP_DANGEROUSLY_ALLOW_DCR === 'true',
    })
    .option('trust-proxy', {
      type: 'string',
      description:
        'Express trust proxy setting when behind a reverse proxy (e.g. "1", "true", or a CIDR)',
      default: process.env.TRUST_PROXY || undefined,
    })
    .help()
    .parseSync();

  // Build instance configs: OPENCLAW_INSTANCES takes precedence, otherwise single-instance from existing env vars
  let instances: InstanceConfig[];
  const instancesEnv = process.env.OPENCLAW_INSTANCES;

  if (instancesEnv) {
    try {
      const parsed = JSON.parse(instancesEnv);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('OPENCLAW_INSTANCES must be a non-empty JSON array');
      }
      // Validate each item has required fields
      for (const item of parsed) {
        if (!item || typeof item.name !== 'string' || !item.name.trim()) {
          throw new Error(
            'Each instance in OPENCLAW_INSTANCES must have a non-empty string "name"'
          );
        }
        if (typeof item.url !== 'string' || !item.url.trim()) {
          throw new Error(`Instance "${item.name}": must have a non-empty string "url"`);
        }
      }
      // Apply global timeout fallback for instances that don't specify their own
      instances = (parsed as InstanceConfig[]).map((cfg) => ({
        ...cfg,
        timeout: cfg.timeout ?? argv.timeout,
      }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`OPENCLAW_INSTANCES contains invalid JSON: ${error.message}`);
      }
      throw error;
    }
  } else {
    // Backward-compatible: single instance from existing env vars / CLI args
    instances = [
      {
        name: 'default',
        url: argv['openclaw-url'] as string,
        token: argv['gateway-token'] as string | undefined,
        timeout: argv.timeout,
        default: true,
      },
    ];
  }

  return {
    openclawUrl: argv['openclaw-url'] as string,
    gatewayToken: argv['gateway-token'] as string | undefined,
    model: argv.model as string,
    transport: argv.transport as 'stdio' | 'sse',
    port: argv.port,
    host: argv.host,
    timeout: argv.timeout,
    debug: argv.debug,
    authEnabled: argv.auth,
    clientId: argv['client-id'] as string | undefined,
    clientSecret: argv['client-secret'] as string | undefined,
    issuerUrl: argv['issuer-url'] as string | undefined,
    redirectUris: argv['redirect-uris']
      ? (argv['redirect-uris'] as string)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    allowDcr: argv['allow-dcr'] as boolean,
    trustProxy: argv['trust-proxy'] as string | undefined,
    instances,
  };
}
