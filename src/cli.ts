import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { DEFAULT_OPENCLAW_URL } from './config/constants.js';

export interface CliArgs {
  openclawUrl: string;
  gatewayToken: string | undefined;
  transport: 'stdio' | 'sse';
  port: number;
  host: string;
  timeout: number;
  authEnabled: boolean;
  clientId: string | undefined;
  clientSecret: string | undefined;
  issuerUrl: string | undefined;
  redirectUris: string[] | undefined;
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
    .help()
    .parseSync();

  return {
    openclawUrl: argv['openclaw-url'] as string,
    gatewayToken: argv['gateway-token'] as string | undefined,
    transport: argv.transport as 'stdio' | 'sse',
    port: argv.port,
    host: argv.host,
    timeout: argv.timeout,
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
  };
}
