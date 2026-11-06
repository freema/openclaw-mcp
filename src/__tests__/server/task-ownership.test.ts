/**
 * Async task ownership over the stateless HTTP transport.
 *
 * Every request to /mcp is served by a fresh McpServer with no session, so
 * the only stable identity is the OAuth client behind the bearer token. These
 * tests run the real app from createHttpApp() and talk to it with the SDK's
 * own client, both as a 2025-era client and as a 2026-07-28 one, through two
 * independently registered OAuth clients.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { InstanceRegistry } from '../../openclaw/registry.js';
import { taskManager } from '../../mcp/tasks/manager.js';
import { createHttpApp, type HttpServerConfig } from '../../server/http.js';
import { PROCESS_TASK_OWNER, resolveTaskOwner } from '../../server/mcp-server.js';

vi.spyOn(console, 'error').mockImplementation(() => {});

const STATIC_CLIENT_ID = 'static-client';
const STATIC_CLIENT_SECRET = 'static-secret-value-of-at-least-32-chars';
const REDIRECT_URI = 'http://localhost/callback';

type Era = 'legacy' | 'modern';
const ERAS: Era[] = ['legacy', 'modern'];

interface RunningApp {
  baseUrl: string;
  stop: () => Promise<void>;
}

async function startApp(authConfig: HttpServerConfig['authConfig']): Promise<RunningApp> {
  const registry = new InstanceRegistry(
    [{ name: 'default', url: 'http://127.0.0.1:1', default: true }],
    'openclaw'
  );
  const httpApp = createHttpApp(
    { port: 0, host: '127.0.0.1', authConfig },
    { registry, serverName: 'test', serverVersion: '0.0.0' }
  );
  const server = await new Promise<http.Server>((resolve) => {
    const s = httpApp.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    stop: async () => {
      await httpApp.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** RFC 7591 dynamic registration: a second, independent OAuth client. */
async function registerClient(baseUrl: string): Promise<OAuthClient> {
  const res = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: 'second client' }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string; client_secret: string };
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

/** Authorization code + PKCE, exactly as a real client obtains its token. */
async function getAccessToken(baseUrl: string, client: OAuthClient): Promise<string> {
  const codeVerifier = randomUUID() + randomUUID();
  const authorizeUrl = new URL(`${baseUrl}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', client.clientId);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set(
    'code_challenge',
    createHash('sha256').update(codeVerifier).digest('base64url')
  );
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(authorized.status).toBe(302);
  const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;

  const res = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: REDIRECT_URI,
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

interface ToolResult {
  text: string;
  isError: boolean;
}

const openConnections: Client[] = [];

/** One MCP client connection. Each tool call is a separate HTTP request. */
async function connect(baseUrl: string, era: Era, token?: string) {
  const client = new Client(
    { name: 'ownership-test', version: '0.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      token ? { authProvider: { token: async () => token } } : {}
    )
  );
  expect(client.getProtocolEra()).toBe(era);
  openConnections.push(client);

  return async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { text: content[0].text, isError: result.isError === true };
  };
}

async function queue(call: Awaited<ReturnType<typeof connect>>, message: string): Promise<string> {
  const result = await call('openclaw_chat_async', { message });
  expect(result.isError).toBe(false);
  const taskId = JSON.parse(result.text).task_id as string;
  expect(taskId).toMatch(/^task_[0-9a-f-]{36}$/);
  return taskId;
}

beforeEach(() => {
  // Keep tasks pending so nothing tries to reach a gateway.
  vi.spyOn(taskManager, 'getNextPending').mockReturnValue(undefined);
});

afterEach(async () => {
  while (openConnections.length) await openConnections.pop()!.close();
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('resolveTaskOwner', () => {
  const authFor = (clientId: string) => ({ token: `token-${clientId}`, clientId, scopes: [] });

  it('binds to the OAuth client when the caller is authenticated', () => {
    expect(resolveTaskOwner(authFor('openclaw'))).toBe('client:openclaw');
    expect(resolveTaskOwner(authFor('openclaw'), true)).toBe('client:openclaw');
  });

  it('uses the single process owner without an authenticated principal', () => {
    expect(resolveTaskOwner(undefined)).toBe(PROCESS_TASK_OWNER);
  });

  it('keeps the client and process namespaces apart', () => {
    // A client that registers under the process owner's name must not land in it.
    expect(resolveTaskOwner(authFor(PROCESS_TASK_OWNER))).not.toBe(PROCESS_TASK_OWNER);
  });

  it('fails closed when auth is required but the request has no client identity', () => {
    expect(() => resolveTaskOwner(undefined, true)).toThrow(/no OAuth client identity/);
    expect(() => resolveTaskOwner({ token: 't', clientId: '', scopes: [] }, true)).toThrow();
  });
});

describe('task ownership over stateless HTTP with OAuth', () => {
  let app: RunningApp;
  let aliceToken: string;
  let malloryToken: string;

  beforeAll(async () => {
    app = await startApp({
      clientId: STATIC_CLIENT_ID,
      clientSecret: STATIC_CLIENT_SECRET,
      allowDynamicRegistration: true,
    });
    aliceToken = await getAccessToken(app.baseUrl, {
      clientId: STATIC_CLIENT_ID,
      clientSecret: STATIC_CLIENT_SECRET,
    });
    malloryToken = await getAccessToken(app.baseUrl, await registerClient(app.baseUrl));
  });

  afterAll(() => app.stop());

  describe.each(ERAS)('%s-era client', (era) => {
    it('lets a client poll, list and cancel its own task across separate requests', async () => {
      const alice = await connect(app.baseUrl, era, aliceToken);
      const taskId = await queue(alice, `own task (${era})`);

      const status = await alice('openclaw_task_status', { task_id: taskId });
      expect(status.isError).toBe(false);
      expect(JSON.parse(status.text)).toMatchObject({ task_id: taskId, status: 'pending' });

      const list = JSON.parse((await alice('openclaw_task_list')).text);
      expect(list.tasks.map((t: { task_id: string }) => t.task_id)).toContain(taskId);

      const cancel = await alice('openclaw_task_cancel', { task_id: taskId });
      expect(cancel.isError).toBe(false);
      expect(
        JSON.parse((await alice('openclaw_task_status', { task_id: taskId })).text)
      ).toMatchObject({ status: 'cancelled' });
    });

    it('lets the same OAuth client reach its task from a new connection and a new token', async () => {
      const first = await connect(app.baseUrl, era, aliceToken);
      const taskId = await queue(first, `resumable task (${era})`);

      const freshToken = await getAccessToken(app.baseUrl, {
        clientId: STATIC_CLIENT_ID,
        clientSecret: STATIC_CLIENT_SECRET,
      });
      expect(freshToken).not.toBe(aliceToken);
      const second = await connect(app.baseUrl, era, freshToken);

      const status = await second('openclaw_task_status', { task_id: taskId });
      expect(status.isError).toBe(false);
      expect(JSON.parse(status.text).task_id).toBe(taskId);
      expect((await second('openclaw_task_list')).text).toContain(taskId);
    });

    it("hides one client's task from another client: no read, list, stats or cancel", async () => {
      const alice = await connect(app.baseUrl, era, aliceToken);
      const mallory = await connect(app.baseUrl, era, malloryToken);
      const taskId = await queue(alice, `private task (${era})`);

      // Same answer as for an ID that never existed: no existence oracle.
      const unknownId = `task_${randomUUID()}`;
      const foreign = await mallory('openclaw_task_status', { task_id: taskId });
      const unknown = await mallory('openclaw_task_status', { task_id: unknownId });
      expect(foreign).toEqual({ isError: true, text: `Error: Task not found: ${taskId}` });
      expect(unknown).toEqual({ isError: true, text: `Error: Task not found: ${unknownId}` });

      const statsBefore = JSON.parse((await mallory('openclaw_task_list')).text);
      expect(JSON.stringify(statsBefore)).not.toContain(taskId);
      const ownId = await queue(mallory, `mallory's own task (${era})`);
      const statsAfter = JSON.parse((await mallory('openclaw_task_list')).text);
      expect(statsAfter.stats.total).toBe(statsBefore.stats.total + 1);
      expect(statsAfter.tasks.map((t: { task_id: string }) => t.task_id)).toContain(ownId);
      expect(JSON.stringify(statsAfter)).not.toContain(taskId);

      const cancel = await mallory('openclaw_task_cancel', { task_id: taskId });
      expect(cancel).toEqual({ isError: true, text: `Error: Task not found: ${taskId}` });

      // Untouched for its owner, who in turn cannot see Mallory's task.
      const stillThere = await alice('openclaw_task_status', { task_id: taskId });
      expect(JSON.parse(stillThere.text).status).toBe('pending');
      expect((await alice('openclaw_task_status', { task_id: ownId })).isError).toBe(true);
    });
  });

  it('shares ownership between eras: the owner is the client, not the protocol', async () => {
    const legacy = await connect(app.baseUrl, 'legacy', aliceToken);
    const modern = await connect(app.baseUrl, 'modern', aliceToken);
    const taskId = await queue(legacy, 'cross-era task');
    expect((await modern('openclaw_task_status', { task_id: taskId })).isError).toBe(false);
  });

  it('never tells a client who owns a task', async () => {
    const alice = await connect(app.baseUrl, 'modern', aliceToken);
    const taskId = await queue(alice, 'owner must stay internal');
    const status = (await alice('openclaw_task_status', { task_id: taskId })).text;
    const list = (await alice('openclaw_task_list')).text;
    for (const text of [status, list]) {
      expect(text).not.toContain('ownerId');
      expect(text).not.toContain(`client:${STATIC_CLIENT_ID}`);
    }
  });
});

describe('task ownership with auth disabled (MCP_DANGEROUSLY_DISABLE_AUTH)', () => {
  let app: RunningApp;

  beforeAll(async () => {
    app = await startApp(undefined);
  });

  afterAll(() => app.stop());

  it.each(ERAS)('uses one owner for the whole process (%s-era client)', async (era) => {
    const first = await connect(app.baseUrl, era);
    const second = await connect(app.baseUrl, era);
    const taskId = await queue(first, `unauthenticated task (${era})`);

    expect((await first('openclaw_task_status', { task_id: taskId })).isError).toBe(false);
    expect((await second('openclaw_task_status', { task_id: taskId })).isError).toBe(false);
    expect(taskManager.get(taskId, PROCESS_TASK_OWNER)).toBeDefined();
  });

  it('keeps the process owner apart from every OAuth client', async () => {
    const anonymous = await connect(app.baseUrl, 'modern');
    const taskId = await queue(anonymous, 'process-owned task');
    expect(taskManager.get(taskId, `client:${STATIC_CLIENT_ID}`)).toBeUndefined();
    expect(taskManager.get(taskId, `client:${PROCESS_TASK_OWNER}`)).toBeUndefined();
  });
});
