/**
 * Auth resolution for the HTTP transport.
 *
 * OAuth is mandatory in HTTP mode. Before 1.8.0 the HTTP transport ran without
 * authentication unless AUTH_ENABLED=true was set, so a plain `docker run` of
 * the published image exposed every tool to anyone who could reach the port.
 * The only way to run HTTP without auth is now the explicit
 * `--dangerously-disable-auth` / MCP_DANGEROUSLY_DISABLE_AUTH=true opt-out.
 */

import type { AuthProviderConfig } from '../auth/provider.js';

export interface HttpAuthInput {
  host: string;
  /** AUTH_ENABLED / --auth. `undefined` when not set; it no longer controls the default. */
  authEnabled: boolean | undefined;
  dangerouslyDisableAuth: boolean;
  clientId: string | undefined;
  clientSecret: string | undefined;
  redirectUris: string[] | undefined;
  allowDcr: boolean;
  allowDcrPublic: boolean;
}

export type HttpAuthResolution =
  | { ok: true; authConfig: AuthProviderConfig | undefined; info: string[]; warnings: string[] }
  | { ok: false; error: string };

const CLIENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/;
const MIN_CLIENT_SECRET_LENGTH = 32;

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function resolveHttpAuth(input: HttpAuthInput): HttpAuthResolution {
  if (input.dangerouslyDisableAuth) {
    const warnings = [
      'WARNING: MCP_DANGEROUSLY_DISABLE_AUTH is set — OAuth is DISABLED. Anyone who can reach ' +
        `${input.host} can call every tool and talk to your OpenClaw gateway. ` +
        'Only use this behind a proxy that authenticates requests, or on a trusted loopback setup.',
    ];
    if (input.clientId || input.clientSecret) {
      warnings.push(
        'WARNING: MCP_CLIENT_ID / MCP_CLIENT_SECRET are set but ignored because auth is disabled.'
      );
    }
    return { ok: true, authConfig: undefined, info: [], warnings };
  }

  if (input.authEnabled === false) {
    return {
      ok: false,
      error:
        'AUTH_ENABLED=false no longer disables authentication — OAuth is mandatory for the HTTP ' +
        'transport since 1.8.0. Remove AUTH_ENABLED and set MCP_CLIENT_ID + MCP_CLIENT_SECRET, ' +
        'or set MCP_DANGEROUSLY_DISABLE_AUTH=true (--dangerously-disable-auth) if you really ' +
        'want an unauthenticated server. Refusing to start.',
    };
  }

  if (!input.clientId) {
    return {
      ok: false,
      error:
        'The HTTP transport requires OAuth: set MCP_CLIENT_ID and MCP_CLIENT_SECRET ' +
        '(generate the secret with: openssl rand -hex 32). To run without authentication, ' +
        'set MCP_DANGEROUSLY_DISABLE_AUTH=true (--dangerously-disable-auth). Refusing to start.',
    };
  }

  if (!CLIENT_ID_PATTERN.test(input.clientId)) {
    return {
      ok: false,
      error:
        'MCP_CLIENT_ID is invalid. Must be 3-64 characters, alphanumeric/dashes/underscores, start with a letter or digit.',
    };
  }

  if (!input.clientSecret || input.clientSecret.length < MIN_CLIENT_SECRET_LENGTH) {
    return {
      ok: false,
      error: `MCP_CLIENT_SECRET must be at least ${MIN_CLIENT_SECRET_LENGTH} characters. Generate one with: openssl rand -hex 32`,
    };
  }

  const info = [`OAuth client ID: ${input.clientId}`];
  const warnings: string[] = [];

  if (!input.redirectUris || input.redirectUris.length === 0) {
    warnings.push(
      'WARNING: MCP_REDIRECT_URIS not set — any redirect_uri will be accepted. ' +
        'Set MCP_REDIRECT_URIS for production.'
    );
  }

  if (input.allowDcr) {
    // DCR + auto-approve = any reachable client can self-register and obtain
    // a bearer token without user interaction. Refuse to bind non-loopback
    // hosts unless the operator explicitly opts in via the escape hatch.
    if (!isLoopbackHost(input.host) && !input.allowDcrPublic) {
      return {
        ok: false,
        error:
          `MCP_DANGEROUSLY_ALLOW_DCR=true is set but HOST="${input.host}" is not loopback. ` +
          'Dynamic Client Registration combined with a publicly reachable bind allows ' +
          'anyone on the network to obtain a token. Bind to 127.0.0.1, or set ' +
          'MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC=true to override. Refusing to start.',
      };
    }
    warnings.push(
      'WARNING: MCP_DANGEROUSLY_ALLOW_DCR is enabled — OAuth Dynamic Client Registration is open. ' +
        'Any client that can reach this server may self-register and obtain tokens. ' +
        'Use for local development only.'
    );
    if (input.allowDcrPublic) {
      warnings.push(
        'WARNING: MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC=true — DCR is exposed on a non-loopback bind. ' +
          'You have explicitly accepted the risk.'
      );
    }
  }

  return {
    ok: true,
    authConfig: {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      redirectUris: input.redirectUris,
      allowDynamicRegistration: input.allowDcr,
    },
    info,
    warnings,
  };
}
