/**
 * Integration test: verify that OAuth auth is enforced at the HTTP level.
 *
 * Starts a real Express server (our v2 auth router + SDK v2 bearer middleware)
 * and makes HTTP requests to confirm:
 * - /health is always accessible (no auth)
 * - /mcp returns 401 without a valid Bearer token
 * - Dynamic registration is disabled (returns 404)
 * - Full OAuth flow (authorize → token → access) with pre-configured client works
 * - PKCE is enforced on token exchange
 * - Unknown client_id is rejected
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/express';

import { OpenClawAuthProvider } from '../../auth/provider.js';
import { createAuthRouter } from '../../auth/router.js';

const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret-value';

let server: http.Server;
let baseUrl: string;

function createTestApp() {
  const provider = new OpenClawAuthProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const app = express();

  app.use(
    createAuthRouter({
      provider,
      issuerUrl: new URL('http://127.0.0.1:0'),
      scopesSupported: ['mcp:tools'],
    })
  );

  const bearerAuth = requireBearerAuth({ verifier: provider });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.post('/mcp', bearerAuth, (_req: Request, res: Response) => {
    res.json({ result: 'mcp-ok' });
  });

  return { app, provider };
}

beforeAll(async () => {
  const { app } = createTestApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// --- Tests ---

describe('Auth enforcement', () => {
  it('GET /health returns 200 (no auth)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('POST /mcp returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('POST /mcp returns 401 with invalid Bearer token', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bad-token' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('Dynamic registration is disabled', () => {
  it('POST /register returns 404 (not installed)', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost/callback'],
        client_name: 'Evil Client',
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe('OAuth metadata', () => {
  it('returns metadata without registration_endpoint', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.token_endpoint).toBeDefined();
    expect(body.authorization_endpoint).toBeDefined();
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    // Registration should NOT be advertised
    expect(body.registration_endpoint).toBeUndefined();
  });
});

describe('Full OAuth flow with pre-configured client', () => {
  it('authorize → token → access works with correct client_id + secret', async () => {
    const state = randomUUID();
    const codeVerifier = randomUUID();
    // S256: BASE64URL(SHA256(code_verifier))
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    // Step 1: Authorize
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', 'http://localhost/callback');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const authorizeRes = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
    expect(authorizeRes.status).toBe(302);
    const location = authorizeRes.headers.get('location')!;
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location);
    const code = redirectUrl.searchParams.get('code')!;
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get('state')).toBe(state);

    // Step 2: Token exchange
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost/callback',
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens: any = await tokenRes.json();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.token_type).toBe('bearer');

    // Step 3: Access protected endpoint
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: '{}',
    });
    expect(mcpRes.status).toBe(200);

    // Step 4: Refresh token rotation
    const refreshRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed: any = await refreshRes.json();
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
  });

  it('token exchange fails with wrong code_verifier (PKCE)', async () => {
    const codeChallenge = createHash('sha256').update('right-verifier').digest('base64url');

    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', 'http://localhost/callback');
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const authorizeRes = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
    const code = new URL(authorizeRes.headers.get('location')!).searchParams.get('code')!;

    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: 'wrong-verifier',
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
    const body: any = await tokenRes.json();
    expect(body.error).toBe('invalid_grant');
  });

  it('token exchange fails with wrong client_secret', async () => {
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'whatever',
        client_id: CLIENT_ID,
        client_secret: 'wrong-secret',
        code_verifier: 'v',
      }).toString(),
    });
    expect(tokenRes.status).toBe(401);
    const body: any = await tokenRes.json();
    expect(body.error).toBe('invalid_client');
  });

  it('authorize rejects unknown client_id', async () => {
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', 'unknown-client');
    authorizeUrl.searchParams.set('redirect_uri', 'http://localhost/callback');
    authorizeUrl.searchParams.set('code_challenge', 'test');
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const res = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error).toBe('invalid_client');
  });

  it('authorize accepts the claude.ai callback with allow-any default', async () => {
    // Claude.ai sends exactly this redirect_uri. With MCP_REDIRECT_URIS unset,
    // the allow-any fallback must accept it.
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback');
    authorizeUrl.searchParams.set('code_challenge', 'test-challenge');
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', 'mcp:tools');

    const res = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(location.searchParams.get('code')).toBeTruthy();
  });
});

describe('Explicit redirect URI allow-list (MCP_REDIRECT_URIS)', () => {
  const ALLOWED_URI = 'https://claude.ai/api/mcp/auth_callback';
  let restrictedServer: http.Server;
  let restrictedBaseUrl: string;

  beforeAll(async () => {
    const provider = new OpenClawAuthProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUris: [ALLOWED_URI],
    });
    const app = express();
    app.use(
      createAuthRouter({
        provider,
        issuerUrl: new URL('http://127.0.0.1:0'),
        scopesSupported: ['mcp:tools'],
      })
    );
    await new Promise<void>((resolve) => {
      restrictedServer = app.listen(0, '127.0.0.1', () => {
        const addr = restrictedServer.address() as { port: number };
        restrictedBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      restrictedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function authorizeUrlWith(redirectUri: string): string {
    const url = new URL(`${restrictedBaseUrl}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code_challenge', 'test-challenge');
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  it('accepts a listed redirect_uri', async () => {
    const res = await fetch(authorizeUrlWith(ALLOWED_URI), { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(ALLOWED_URI);
    expect(location.searchParams.get('code')).toBeTruthy();
  });

  it('rejects an unlisted redirect_uri', async () => {
    const res = await fetch(authorizeUrlWith('https://evil.example.com/callback'), {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe('invalid_request');
  });
});
