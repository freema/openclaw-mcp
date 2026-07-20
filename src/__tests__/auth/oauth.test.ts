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

  it('rejects dynamic registration by default', () => {
    const store = new OpenClawClientsStore({});
    expect(store.allowDynamicRegistration).toBe(false);
    expect(() =>
      store.registerClient({
        client_id: 'dyn-id',
        redirect_uris: ['http://localhost/cb'],
      } as any)
    ).toThrow('Dynamic registration is disabled');
  });

  it('accepts registration when allowDynamicRegistration is true', async () => {
    const store = new OpenClawClientsStore({ allowDynamicRegistration: true });
    expect(store.allowDynamicRegistration).toBe(true);

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
    const registered = store.registerClient(dynamic as any);
    expect(registered.client_id).toBe('dyn-id');

    const fetched = await store.getClient('dyn-id');
    expect(fetched?.client_secret).toBe('dyn-secret');
  });

  it('evicts oldest dynamically registered client when cap is exceeded', async () => {
    const store = new OpenClawClientsStore({ allowDynamicRegistration: true });
    const register = (client: unknown) => store.registerClient(client as any);
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

    store.registerClient({
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
    // SDK ≤1.28 membership check
    expect(client?.redirect_uris.includes('http://any-uri.com/callback')).toBe(true);
    expect(client?.redirect_uris.includes('https://claude.ai/oauth/callback')).toBe(true);
    // SDK ≥1.29 membership check (.some(redirectUriMatches))
    expect(
      client?.redirect_uris.some((registered) => registered === 'http://any-uri.com/callback')
    ).toBe(true);
    // Empty backing list → when a client omits redirect_uri entirely, the SDK
    // reports a validation error instead of redirecting to undefined
    expect(client?.redirect_uris.length).toBe(0);
  });

  it('uses the explicit redirect URI list when configured', async () => {
    const store = new OpenClawClientsStore({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    const client = await store.getClient('test-id');
    expect(client?.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
    expect(client?.redirect_uris.includes('https://evil.example.com/callback')).toBe(false);
    expect(client?.redirect_uris.some((r) => r === 'https://evil.example.com/callback')).toBe(
      false
    );
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

    // Authorize returns the redirect URL directly
    const redirectUrl = provider.authorize(client, {
      state: 'my-state',
      scopes: ['mcp:tools'],
      codeChallenge: 'test-challenge',
      redirectUri: 'http://localhost/callback',
    });

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

    expect(() => provider.exchangeAuthorizationCode(client, 'bad-code')).toThrow(
      'Invalid authorization code'
    );
  });

  it('rejects code exchange from wrong client', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    // Authorize with the real client
    const redirectUrl = provider.authorize(client, {
      codeChallenge: 'ch',
      redirectUri: 'http://localhost/cb',
    });

    const url = new URL(redirectUrl);
    const code = url.searchParams.get('code')!;

    // Try to exchange with a different client
    const otherClient = { ...client, client_id: 'other' };
    expect(() => provider.exchangeAuthorizationCode(otherClient, code)).toThrow(
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
    const redirectUrl = provider.authorize(client, {
      codeChallenge: 'ch',
      redirectUri: 'http://localhost/cb',
    });

    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = provider.exchangeAuthorizationCode(client, code);

    // Refresh
    const newTokens = provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(newTokens.access_token).toBeTruthy();
    expect(newTokens.access_token).not.toBe(tokens.access_token);
    expect(newTokens.refresh_token).toBeTruthy();

    // Old refresh token should be revoked (rotation)
    expect(() => provider.exchangeRefreshToken(client, tokens.refresh_token!)).toThrow(
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
    const redirectUrl = provider.authorize(client, {
      codeChallenge: 'ch',
      redirectUri: 'http://localhost/cb',
    });

    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = provider.exchangeAuthorizationCode(client, code);

    // Revoke
    provider.revokeToken(client, { token: tokens.access_token });

    // Should be invalid now
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(
      'Invalid or expired token'
    );
  });

  it('rejects a refresh that widens the granted scopes', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    const redirectUrl = provider.authorize(client, {
      codeChallenge: 'ch',
      redirectUri: 'http://localhost/cb',
      scopes: ['mcp:tools'],
    });
    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = provider.exchangeAuthorizationCode(client, code);

    expect(() =>
      provider.exchangeRefreshToken(client, tokens.refresh_token!, [
        'mcp:tools',
        'admin:everything',
      ])
    ).toThrow(/exceeds the original grant/);

    // Narrowing is still allowed.
    const narrowed = provider.exchangeRefreshToken(client, tokens.refresh_token!, []);
    expect(narrowed.scope).toBe('mcp:tools');
  });

  it('revoking either token kills the whole grant family', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    const redirectUrl = provider.authorize(client, {
      codeChallenge: 'ch',
      redirectUri: 'http://localhost/cb',
      scopes: ['mcp:tools'],
    });
    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = provider.exchangeAuthorizationCode(client, code);

    // Revoke the access token — the paired refresh token must die with it,
    // otherwise it keeps minting fresh access tokens after a leak.
    provider.revokeToken(client, { token: tokens.access_token });

    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    expect(() => provider.exchangeRefreshToken(client, tokens.refresh_token!)).toThrow(
      'Invalid refresh token'
    );
  });

  it('revoking a rotated refresh token kills the tokens it produced', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    const redirectUrl = provider.authorize(client, {
      codeChallenge: 'ch',
      redirectUri: 'http://localhost/cb',
    });
    const code = new URL(redirectUrl).searchParams.get('code')!;
    const first = provider.exchangeAuthorizationCode(client, code);
    const second = provider.exchangeRefreshToken(client, first.refresh_token!);

    // Rotation keeps the same grant, so revoking the new refresh token must
    // also invalidate the access token issued alongside it.
    provider.revokeToken(client, { token: second.refresh_token! });
    await expect(provider.verifyAccessToken(second.access_token)).rejects.toThrow();
  });

  it('does not let the token endpoint widen the audience set at authorize time', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    const redirectUrl = provider.authorize(client, {
      codeChallenge: 'ch',
      redirectUri: 'http://localhost/cb',
      resource: new URL('https://mcp.example.com/mcp'),
    });
    const code = new URL(redirectUrl).searchParams.get('code')!;
    provider.exchangeAuthorizationCode(client, code, new URL('https://other.example.com/'));

    const info = await provider.verifyAccessToken(
      // re-derive: the token just minted is the only one in the store
      (() => {
        const url = provider.authorize(client, {
          codeChallenge: 'ch2',
          redirectUri: 'http://localhost/cb',
          resource: new URL('https://mcp.example.com/mcp'),
        });
        const c = new URL(url).searchParams.get('code')!;
        return provider.exchangeAuthorizationCode(client, c, new URL('https://other.example.com/'))
          .access_token;
      })()
    );
    expect(info.resource?.toString()).toBe('https://mcp.example.com/mcp');
  });

  it('does not revoke tokens owned by another client', async () => {
    const provider = new OpenClawAuthProvider(config);
    const client = (await provider.clientsStore.getClient('test-client'))!;

    const redirectUrl = provider.authorize(client, {
      codeChallenge: 'ch',
      redirectUri: 'http://localhost/cb',
    });
    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = provider.exchangeAuthorizationCode(client, code);

    const attacker = { ...client, client_id: 'attacker' };
    provider.revokeToken(attacker, { token: tokens.access_token });

    // Token must still be valid — attacker is not allowed to revoke it.
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe('test-client');
  });
});
