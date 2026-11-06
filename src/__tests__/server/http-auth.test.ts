import { describe, it, expect } from 'vitest';

import { resolveHttpAuth, type HttpAuthInput } from '../../server/http-auth.js';
import { parseEnvBoolean } from '../../cli.js';

const SECRET = 'a'.repeat(64);

function input(overrides: Partial<HttpAuthInput> = {}): HttpAuthInput {
  return {
    host: '0.0.0.0',
    authEnabled: undefined,
    dangerouslyDisableAuth: false,
    clientId: undefined,
    clientSecret: undefined,
    redirectUris: undefined,
    allowDcr: false,
    allowDcrPublic: false,
    ...overrides,
  };
}

describe('resolveHttpAuth', () => {
  it('refuses to start without client credentials (no more fail-open default)', () => {
    const result = resolveHttpAuth(input());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('MCP_DANGEROUSLY_DISABLE_AUTH');
  });

  it('enables OAuth from credentials alone — AUTH_ENABLED is not needed', () => {
    const result = resolveHttpAuth(input({ clientId: 'openclaw', clientSecret: SECRET }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.authConfig?.clientId).toBe('openclaw');
  });

  it('still accepts AUTH_ENABLED=true', () => {
    const result = resolveHttpAuth(
      input({ authEnabled: true, clientId: 'openclaw', clientSecret: SECRET })
    );
    expect(result.ok && result.authConfig?.clientId).toBe('openclaw');
  });

  it('refuses AUTH_ENABLED=false instead of silently disabling auth', () => {
    const withCreds = resolveHttpAuth(
      input({ authEnabled: false, clientId: 'openclaw', clientSecret: SECRET })
    );
    expect(withCreds.ok).toBe(false);
    expect(withCreds.ok === false && withCreds.error).toContain('AUTH_ENABLED=false');

    expect(resolveHttpAuth(input({ authEnabled: false })).ok).toBe(false);
  });

  it('runs without auth only with the explicit dangerous opt-out, and warns', () => {
    const result = resolveHttpAuth(input({ dangerouslyDisableAuth: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authConfig).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('OAuth is DISABLED');
  });

  it('warns that credentials are ignored when auth is dangerously disabled', () => {
    const result = resolveHttpAuth(
      input({ dangerouslyDisableAuth: true, clientId: 'openclaw', clientSecret: SECRET })
    );
    expect(result.ok && result.authConfig).toBeUndefined();
    expect(result.ok && result.warnings.join('\n')).toContain('ignored');
  });

  it('validates the client ID and secret', () => {
    expect(resolveHttpAuth(input({ clientId: 'x', clientSecret: SECRET })).ok).toBe(false);
    expect(resolveHttpAuth(input({ clientId: 'openclaw', clientSecret: 'short' })).ok).toBe(false);
    expect(resolveHttpAuth(input({ clientId: 'openclaw' })).ok).toBe(false);
  });

  it('keeps refusing DCR on a non-loopback bind without the public opt-in', () => {
    const creds = { clientId: 'openclaw', clientSecret: SECRET, allowDcr: true };
    expect(resolveHttpAuth(input({ ...creds, host: '0.0.0.0' })).ok).toBe(false);
    expect(resolveHttpAuth(input({ ...creds, host: '127.0.0.1' })).ok).toBe(true);
    expect(resolveHttpAuth(input({ ...creds, host: '0.0.0.0', allowDcrPublic: true })).ok).toBe(
      true
    );
  });

  it('warns about a missing redirect URI allowlist', () => {
    const result = resolveHttpAuth(input({ clientId: 'openclaw', clientSecret: SECRET }));
    expect(result.ok && result.warnings.join('\n')).toContain('MCP_REDIRECT_URIS');
  });
});

describe('parseEnvBoolean', () => {
  it('distinguishes unset from false', () => {
    expect(parseEnvBoolean(undefined)).toBeUndefined();
    expect(parseEnvBoolean('')).toBeUndefined();
    expect(parseEnvBoolean('true')).toBe(true);
    expect(parseEnvBoolean('false')).toBe(false);
  });
});
