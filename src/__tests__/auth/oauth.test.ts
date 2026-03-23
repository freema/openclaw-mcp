import { describe, it, expect } from 'vitest';
import { OpenClawAuthProvider, OpenClawClientsStore } from '../../auth/provider.js';

describe('OpenClawClientsStore', () => {
  it('returns pre-configured client by ID', async () => {
    const store = new OpenClawClientsStore({ clientId: 'test-id', clientSecret: 'test-secret' });
    const client = await store.getClient('test-id');
    expect(client).toBeDefined();
    expect(client?.client_id).toBe('test-id');
    expect(client?.client_secret).toBe('test-secret');
  });

  it('returns undefined for unknown client', async () => {
    const store = new OpenClawClientsStore({ clientId: 'test-id', clientSecret: 'test-secret' });
    const client = await store.getClient('unknown');
    expect(client).toBeUndefined();
  });

  it('does not support dynamic registration', () => {
    const store = new OpenClawClientsStore({});
    expect((store as any).registerClient).toBeUndefined();
  });

  it('works with no pre-configured client', async () => {
    const store = new OpenClawClientsStore({});
    const client = await store.getClient('anything');
    expect(client).toBeUndefined();
  });

  it('accepts any redirect_uri for pre-configured client', async () => {
    const store = new OpenClawClientsStore({ clientId: 'test-id', clientSecret: 'test-secret' });
    const client = await store.getClient('test-id');
    expect(client?.redirect_uris.includes('http://any-uri.com/callback')).toBe(true);
    expect(client?.redirect_uris.includes('https://claude.ai/oauth/callback')).toBe(true);
  });
});

describe('OpenClawAuthProvider', () => {
  const config = { clientId: 'test-client', clientSecret: 'test-secret' };

  it('exposes clientsStore', () => {
    const provider = new OpenClawAuthProvider(config);
    expect(provider.clientsStore).toBeInstanceOf(OpenClawClientsStore);
  });

  it('full auth code flow: authorize → challenge → exchange → verify', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;
    expect(client).toBeDefined();

    // Simulate authorize — capture the redirect URL
    let redirectUrl = '';
    const mockRes = {
      redirect: (url: string) => {
        redirectUrl = url;
      },
      cookie: () => {},
    };

    await provider.authorize(
      client,
      {
        state: 'my-state',
        scopes: ['mcp:tools'],
        codeChallenge: 'test-challenge',
        redirectUri: 'http://localhost/callback',
      },
      mockRes as any
    );

    expect(redirectUrl).toContain('code=');
    expect(redirectUrl).toContain('state=my-state');

    // Extract code
    const url = new URL(redirectUrl);
    const code = url.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // Challenge
    const challenge = await provider.challengeForAuthorizationCode(client, code);
    expect(challenge).toBe('test-challenge');

    // Exchange
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe('bearer');
    expect(tokens.expires_in).toBe(3600);

    // Verify
    const authInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.clientId).toBe('test-client');
    expect(authInfo.scopes).toEqual(['mcp:tools']);
    expect(authInfo.token).toBe(tokens.access_token);
  });

  it('rejects invalid authorization code', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    await expect(provider.exchangeAuthorizationCode(client, 'bad-code')).rejects.toThrow(
      'Invalid authorization code'
    );
  });

  it('rejects code exchange from wrong client', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    // Authorize with the real client
    let redirectUrl = '';
    const mockRes = {
      redirect: (url: string) => {
        redirectUrl = url;
      },
    };
    await provider.authorize(
      client,
      {
        codeChallenge: 'ch',
        redirectUri: 'http://localhost/cb',
      },
      mockRes as any
    );

    const url = new URL(redirectUrl);
    const code = url.searchParams.get('code')!;

    // Try to exchange with a different client
    const otherClient = { ...client, client_id: 'other' };
    await expect(provider.exchangeAuthorizationCode(otherClient, code)).rejects.toThrow(
      'not issued to this client'
    );
  });

  it('rejects expired or invalid access token', async () => {
    const provider = new OpenClawAuthProvider(config);
    await expect(provider.verifyAccessToken('non-existent-token')).rejects.toThrow(
      'Invalid or expired token'
    );
  });

  it('refresh token flow works', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    // Get initial tokens
    let redirectUrl = '';
    const mockRes = {
      redirect: (url: string) => {
        redirectUrl = url;
      },
    };
    await provider.authorize(
      client,
      {
        codeChallenge: 'ch',
        redirectUri: 'http://localhost/cb',
      },
      mockRes as any
    );

    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    // Refresh
    const newTokens = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(newTokens.access_token).toBeTruthy();
    expect(newTokens.access_token).not.toBe(tokens.access_token);
    expect(newTokens.refresh_token).toBeTruthy();

    // Old refresh token should be revoked (rotation)
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(
      'Invalid refresh token'
    );

    // New access token should be valid
    const info = await provider.verifyAccessToken(newTokens.access_token);
    expect(info.clientId).toBe('test-client');
  });

  it('revoke token deletes it', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    // Get tokens
    let redirectUrl = '';
    const mockRes = {
      redirect: (url: string) => {
        redirectUrl = url;
      },
    };
    await provider.authorize(
      client,
      {
        codeChallenge: 'ch',
        redirectUri: 'http://localhost/cb',
      },
      mockRes as any
    );

    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    // Revoke
    await provider.revokeToken(client, { token: tokens.access_token });

    // Should be invalid now
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(
      'Invalid or expired token'
    );
  });

  it('enforces auth code limit', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    const mockRes = { redirect: () => {} };

    // Generate 50 auth codes (MAX_AUTH_CODES)
    for (let i = 0; i < 50; i++) {
      await provider.authorize(
        client,
        { codeChallenge: `ch-${i}`, redirectUri: 'http://localhost/cb' },
        mockRes as any
      );
    }

    // 51st should fail
    await expect(
      provider.authorize(
        client,
        { codeChallenge: 'ch-overflow', redirectUri: 'http://localhost/cb' },
        mockRes as any
      )
    ).rejects.toThrow('Too many pending authorization requests');
  });
});
