/**
 * Integration test: verify that OAuth auth is enforced at the HTTP level.
 *
 * Starts a real Express server and makes HTTP requests to confirm:
 * - /health is always accessible (no auth)
 * - /mcp, /sse (legacy), /messages (legacy) return 401 without a valid Bearer token
 * - Dynamic registration is disabled (returns 404)
 * - Full OAuth flow with pre-configured client works
 * - Unknown client_id is rejected
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { OpenClawAuthProvider } from '../../auth/provider.js';

const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret-value';

let server: http.Server;
let baseUrl: string;

function createTestApp() {
  const provider = new OpenClawAuthProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const app = createMcpExpressApp({ host: '127.0.0.1' });

  const issuerUrl = new URL('http://127.0.0.1:0');
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      scopesSupported: ['mcp:tools'],
    })
  );

  const bearerAuth = requireBearerAuth({ verifier: provider });

  // -- Same pattern as http.ts: withAuth spread --
  const authMiddleware: ((req: Request, res: Response, next: NextFunction) => void) | undefined =
    bearerAuth;

  const withAuth = (handler: (req: Request, res: Response) => Promise<void>) => {
    if (authMiddleware) {
      return [authMiddleware, async (req: Request, res: Response) => handler(req, res)] as const;
    }
    return [async (req: Request, res: Response) => handler(req, res)] as const;
  };

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.post(
    '/mcp',
    ...withAuth(async (_req: Request, res: Response) => {
      res.json({ result: 'mcp-ok' });
    })
  );

  app.get(
    '/sse',
    ...withAuth(async (_req: Request, res: Response) => {
      res.json({ result: 'sse-ok' });
    })
  );

  app.post(
    '/messages',
    ...withAuth(async (_req: Request, res: Response) => {
      res.json({ result: 'messages-ok' });
    })
  );

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

  it('GET /sse returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/sse`);
    expect(res.status).toBe(401);
  });

  it('POST /messages returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/messages`, {
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

    const sseRes = await fetch(`${baseUrl}/sse`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(sseRes.status).toBe(200);
  });

  it('authorize rejects unknown client_id', async () => {
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', 'unknown-client');
    authorizeUrl.searchParams.set('redirect_uri', 'http://localhost/callback');
    authorizeUrl.searchParams.set('code_challenge', 'test');
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const res = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe('invalid_client');
  });
});
