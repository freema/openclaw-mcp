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

  it('does not support dynamic registration by default', () => {
    const store = new OpenClawClientsStore({});
    expect((store as any).registerClient).toBeUndefined();
  });

  it('exposes registerClient when allowDynamicRegistration is true', async () => {
    const store = new OpenClawClientsStore({ allowDynamicRegistration: true });
    expect(typeof (store as any).registerClient).toBe('function');

    const dynamic = {
      client_id: 'dyn-id',
      client_secret: 'dyn-secret',
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'Cursor',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    const registered = await (store as any).registerClient(dynamic);
    expect(registered.client_id).toBe('dyn-id');

    const fetched = await store.getClient('dyn-id');
    expect(fetched?.client_secret).toBe('dyn-secret');
  });

  it('evicts oldest dynamically registered client when cap is exceeded', async () => {
    const store = new OpenClawClientsStore({ allowDynamicRegistration: true });
    const register = (store as any).registerClient.bind(store);
    const makeClient = (id: string) => ({
      client_id: id,
      client_secret: `secret-${id}`,
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'Test',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });

    // Fill past the cap (100) — the first insert should be evicted.
    for (let i = 0; i < 101; i++) {
      await register(makeClient(`client-${i}`));
    }

    expect(await store.getClient('client-0')).toBeUndefined();
    expect((await store.getClient('client-100'))?.client_id).toBe('client-100');
  });

  it('serves both pre-configured and dynamically registered clients', async () => {
    const store = new OpenClawClientsStore({
      clientId: 'preset',
      clientSecret: 'preset-secret',
      allowDynamicRegistration: true,
    });

    await (store as any).registerClient({
      client_id: 'dyn-id',
      client_secret: 'dyn-secret',
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'Cursor',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });

    expect((await store.getClient('preset'))?.client_id).toBe('preset');
    expect((await store.getClient('dyn-id'))?.client_id).toBe('dyn-id');
    expect(await store.getClient('unknown')).toBeUndefined();
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

  it('does not revoke tokens owned by another client', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    let redirectUrl = '';
    const mockRes = {
      redirect: (url: string) => {
        redirectUrl = url;
      },
    };
    await provider.authorize(
      client,
      { codeChallenge: 'ch', redirectUri: 'http://localhost/cb' },
      mockRes as any
    );
    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    const attacker = { ...client, client_id: 'attacker' };
    await provider.revokeToken(attacker, { token: tokens.access_token });

    // Token must still be valid — attacker is not allowed to revoke it.
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe('test-client');
  });
});
