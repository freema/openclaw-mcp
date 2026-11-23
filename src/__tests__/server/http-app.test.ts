/**
 * The real Express app from createHttpApp(), driven over HTTP: request body
 * limit, ordering of authentication and body parsing, and error responses.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

import { InstanceRegistry } from '../../openclaw/registry.js';
import { OAUTH_MAX_BODY_BYTES } from '../../auth/router.js';
import { createHttpApp, httpErrorHandler, MAX_REQUEST_BODY_BYTES } from '../../server/http.js';

vi.spyOn(console, 'error').mockImplementation(() => {});

const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret-value-of-at-least-32-chars';
const REDIRECT_URI = 'http://localhost/callback';

let server: http.Server;
let baseUrl: string;
let closeApp: () => Promise<void>;
let chat: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const registry = new InstanceRegistry([{ name: 'default', url: 'http://127.0.0.1:1' }]);
  // Stand-in for the gateway: report how many characters arrived.
  chat = vi.fn(async (message: string) => ({ response: `received ${message.length} chars` }));
  registry.getDefault().chat = chat as never;

  const httpApp = createHttpApp(
    {
      port: 0,
      host: '127.0.0.1',
      authConfig: {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        allowDynamicRegistration: true,
      },
    },
    { registry, serverName: 'test', serverVersion: '0.0.0' }
  );
  closeApp = httpApp.close;

  await new Promise<void>((resolve) => {
    server = httpApp.app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await closeApp();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function authorize(): Promise<{ code: string; codeVerifier: string }> {
  const codeVerifier = randomUUID() + randomUUID();
  const url = new URL(`${baseUrl}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set(
    'code_challenge',
    createHash('sha256').update(codeVerifier).digest('base64url')
  );
  url.searchParams.set('code_challenge_method', 'S256');
  const res = await fetch(url.toString(), { redirect: 'manual' });
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  return { code, codeVerifier };
}

function tokenRequest(code: string, codeVerifier: string): Record<string, string> {
  return {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  };
}

async function getAccessToken(): Promise<string> {
  const { code, codeVerifier } = await authorize();
  const res = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(tokenRequest(code, codeVerifier)).toString(),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Parse a Streamable HTTP reply, which is either plain JSON or a one-event SSE stream. */
async function readReply(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(text);
}

/**
 * Post a raw body to /mcp as a 2025-era client. The endpoint is stateless, so
 * there is no session to open first: every request stands on its own.
 */
function post(token: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'Mcp-Protocol-Version': '2025-06-18',
    },
    body,
  });
}

function chatCall(message: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'openclaw_chat', arguments: { message } },
  });
}

describe('request body limit', () => {
  it('accepts a maximum-length multi-byte message (would be 413 under a 100 kB default)', async () => {
    const body = chatCall('漢'.repeat(100_000));
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(300_000);

    const res = await post(await getAccessToken(), body);
    expect(res.status).toBe(200);
    const reply = await readReply(res);
    expect(reply.result.content[0].text).toBe('received 100000 chars');
  });

  it('rejects a body over the limit with a JSON-RPC 413 and no stack trace', async () => {
    const res = await post(await getAccessToken(), chatCall('a'.repeat(MAX_REQUEST_BODY_BYTES)));
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('application/json');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `Payload Too Large: request body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes`,
      },
      id: null,
    });
    expect(text).not.toMatch(/node_modules|\.js:\d+|\bat\s/);
  });

  it('refuses a non-JSON Content-Type instead of handling the body unparsed', async () => {
    const callsBefore = chat.mock.calls.length;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${await getAccessToken()}`,
      },
      body: chatCall('hi'),
    });
    const text = await res.text();
    expect(res.status).toBe(415);
    expect(text).not.toMatch(/node_modules|\.js:\d+|\bat\s/);
    expect(chat.mock.calls.length).toBe(callsBefore);
  });

  it('answers malformed JSON with a JSON-RPC parse error, not an HTML page', async () => {
    const res = await post(await getAccessToken(), '{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error: Invalid JSON' },
      id: null,
    });
  });
});

describe('authentication runs before body parsing on the MCP endpoint', () => {
  it('answers 401 without reading an oversized or malformed body', async () => {
    const callsBefore = chat.mock.calls.length;
    for (const path of ['/mcp', '/mcp/', '/MCP']) {
      for (const body of [chatCall('a'.repeat(200_000)), '{not json']) {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        expect(res.status, `${path} with ${body.length} bytes`).toBe(401);
        await res.text();
      }
    }
    expect(chat.mock.calls.length).toBe(callsBefore);
  });

  it('rejects a token that was never issued', async () => {
    const res = await post(randomUUID(), chatCall('hi'));
    expect(res.status).toBe(401);
  });
});

describe('removed legacy SSE transport', () => {
  it('answers 410 on GET /sse and POST /messages without parsing a body', async () => {
    const sse = await fetch(`${baseUrl}/sse`);
    expect(sse.status).toBe(410);
    await sse.text();

    const messages = await fetch(`${baseUrl}/messages?sessionId=unknown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(messages.status).toBe(410);
    expect(((await messages.json()) as { error: string }).error).toContain('/mcp');
  });
});

describe('CORS', () => {
  it('sends no CORS headers unless CORS_ORIGINS opts in', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: 'http://127.0.0.1:9' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects a cross-site Origin on a loopback bind (DNS-rebinding protection)', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('OAuth endpoint body handling', () => {
  it('accepts a JSON-encoded token request, as 1.x did', async () => {
    const { code, codeVerifier } = await authorize();
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenRequest(code, codeVerifier)),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).access_token).toBeTruthy();
  });

  it('still authenticates the client on a JSON-encoded token request', async () => {
    const { code, codeVerifier } = await authorize();
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...tokenRequest(code, codeVerifier), client_secret: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toBe('invalid_client');
  });

  it('limits OAuth bodies to 100 kB and reports errors in OAuth shape', async () => {
    const tooLarge = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: 'a'.repeat(200_000) }),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({
      error: 'invalid_request',
      error_description: `Payload Too Large: request body must not exceed ${OAUTH_MAX_BODY_BYTES} bytes`,
    });

    const tooLargeForm = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'a'.repeat(200_000) }),
    });
    expect(tooLargeForm.status).toBe(413);
    expect(((await tooLargeForm.json()) as any).error).toBe('invalid_request');

    const malformed = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Parse error: Invalid JSON',
    });
  });
});

describe('httpErrorHandler', () => {
  function run(err: unknown, path = '/mcp') {
    const res = {
      headersSent: false,
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };
    const next = vi.fn();
    httpErrorHandler(err, { method: 'POST', path } as never, res as never, next);
    return { res, next };
  }

  it('hides the details of unexpected errors', () => {
    const { res } = run(new Error('secret detail at /srv/app/internal.js:12'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    });
    expect(run(new Error('boom'), '/token').res.body).toEqual({
      error: 'server_error',
      error_description: 'Internal server error',
    });
  });

  it('keeps a client-error status and names it', () => {
    const err = Object.assign(new Error('unsupported charset "X"'), { status: 415 });
    const { res } = run(err);
    expect(res.statusCode).toBe(415);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unsupported Media Type' },
      id: null,
    });
  });

  it('defers to Express once the response has started', () => {
    const res = { headersSent: true, status: vi.fn(), json: vi.fn() };
    const next = vi.fn();
    const err = new Error('late');
    httpErrorHandler(err, { method: 'GET', path: '/mcp' } as never, res as never, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
