/**
 * Task ownership across MCP sessions (#44).
 *
 * Drives real Server instances from createMcpServer() through an in-memory
 * transport, attaching `authInfo` to each request the same way the SDK does
 * after requireBearerAuth on the Streamable HTTP and legacy SSE transports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { InstanceRegistry } from '../../openclaw/registry.js';
import { taskManager } from '../../mcp/tasks/manager.js';
import { createMcpServer, resolveTaskOwner } from '../../server/tools-registration.js';

vi.spyOn(console, 'error').mockImplementation(() => {});

function authFor(clientId: string): AuthInfo {
  return { token: `token-${clientId}`, clientId, scopes: [], expiresAt: Date.now() / 1000 + 3600 };
}

/** One MCP session: a fresh Server, as http.ts creates per connection. */
async function openSession(registry: InstanceRegistry, authInfo?: AuthInfo) {
  const server = createMcpServer({ registry, serverName: 'test', serverVersion: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);

  const pending = new Map<number, (message: JSONRPCMessage) => void>();
  clientSide.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  await clientSide.start();

  let nextId = 1;
  async function callTool(name: string, args: Record<string, unknown>) {
    const id = nextId++;
    const response = new Promise<JSONRPCMessage>((resolve) => pending.set(id, resolve));
    await clientSide.send(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      { authInfo }
    );
    const message = (await response) as unknown as { result: { content: Array<{ text: string }> } };
    const text = message.result.content[0].text;
    return { text, isError: (message.result as { isError?: boolean }).isError === true };
  }

  return { callTool, close: () => server.close() };
}

describe('resolveTaskOwner', () => {
  it('binds to the OAuth client when the caller is authenticated', () => {
    expect(resolveTaskOwner(authFor('openclaw'), 'conn-1')).toBe('client:openclaw');
    expect(resolveTaskOwner(authFor('openclaw'), 'conn-2')).toBe('client:openclaw');
  });

  it('falls back to the connection without an authenticated principal', () => {
    expect(resolveTaskOwner(undefined, 'conn-1')).toBe('connection:conn-1');
  });

  it('keeps client and connection namespaces apart', () => {
    // A client ID that happens to equal a connection ID must not collide.
    expect(resolveTaskOwner(authFor('abc'), 'abc')).not.toBe(resolveTaskOwner(undefined, 'abc'));
  });
});

describe('task ownership across sessions', () => {
  let registry: InstanceRegistry;
  const sessions: Array<{ close: () => Promise<void> }> = [];

  beforeEach(() => {
    registry = new InstanceRegistry(
      [{ name: 'default', url: 'http://localhost:18789', default: true }],
      'openclaw'
    );
    // Keep tasks pending so nothing tries to reach a gateway.
    vi.spyOn(taskManager, 'getNextPending').mockReturnValue(undefined);
  });

  afterEach(async () => {
    while (sessions.length) await sessions.pop()!.close();
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function session(authInfo?: AuthInfo) {
    const s = await openSession(registry, authInfo);
    sessions.push(s);
    return s;
  }

  async function queue(s: Awaited<ReturnType<typeof session>>): Promise<string> {
    const { text } = await s.callTool('openclaw_chat_async', { message: 'Reply with OK.' });
    const taskId = JSON.parse(text).task_id as string;
    expect(taskId).toMatch(/^task_/);
    return taskId;
  }

  it('lets the same OAuth client poll its task from a new session', async () => {
    const first = await session(authFor('client-a'));
    const taskId = await queue(first);

    const second = await session(authFor('client-a'));
    const status = await second.callTool('openclaw_task_status', { task_id: taskId });
    expect(status.isError).toBe(false);
    expect(JSON.parse(status.text).task_id).toBe(taskId);

    const list = await second.callTool('openclaw_task_list', {});
    expect(list.text).toContain(taskId);
  });

  it("hides one client's tasks from another client", async () => {
    const alice = await session(authFor('client-a'));
    const taskId = await queue(alice);

    const mallory = await session(authFor('client-b'));
    const status = await mallory.callTool('openclaw_task_status', { task_id: taskId });
    expect(status.isError).toBe(true);
    expect(status.text).toBe(`Error: Task not found: ${taskId}`);

    const list = await mallory.callTool('openclaw_task_list', {});
    expect(list.text).not.toContain(taskId);

    const cancel = await mallory.callTool('openclaw_task_cancel', { task_id: taskId });
    expect(cancel.isError).toBe(true);

    const stillThere = await alice.callTool('openclaw_task_status', { task_id: taskId });
    expect(JSON.parse(stillThere.text).status).toBe('pending');
  });

  it('keeps unauthenticated connections isolated from each other and from clients', async () => {
    const anonymous = await session();
    const taskId = await queue(anonymous);

    const otherAnonymous = await session();
    expect(
      (await otherAnonymous.callTool('openclaw_task_status', { task_id: taskId })).isError
    ).toBe(true);

    const authenticated = await session(authFor('client-a'));
    expect(
      (await authenticated.callTool('openclaw_task_status', { task_id: taskId })).isError
    ).toBe(true);

    const sameConnection = await anonymous.callTool('openclaw_task_status', { task_id: taskId });
    expect(sameConnection.isError).toBe(false);
  });
});
