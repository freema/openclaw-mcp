/**
 * Handler-level isolation tests.
 *
 * The manager tests cover the storage layer; these drive the actual tool
 * handlers the way a remote client would, and assert that a second connection
 * cannot read, list or cancel the first connection's tasks even when it knows
 * the exact task ID.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { InstanceRegistry } from '../../../openclaw/registry.js';
import { taskManager } from '../../../mcp/tasks/manager.js';
import {
  handleOpenclawChatAsync,
  handleOpenclawTaskStatus,
  handleOpenclawTaskList,
  handleOpenclawTaskCancel,
} from '../../../mcp/tools/tasks.js';

vi.spyOn(console, 'error').mockImplementation(() => {});

// Two MCP connections, as created per-connection in tools-registration.ts.
const ALICE = 'conn-alice';
const MALLORY = 'conn-mallory';

function text(response: { content: Array<{ text: string }> }): string {
  return response.content[0].text;
}

function json(response: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(text(response));
}

describe('async task tools — cross-connection isolation', () => {
  let registry: InstanceRegistry;

  beforeEach(() => {
    for (const owner of [ALICE, MALLORY]) {
      for (const task of taskManager.list(owner)) {
        taskManager.delete(task.id);
      }
    }

    registry = new InstanceRegistry(
      [{ name: 'default', url: 'http://localhost:18789', default: true }],
      'openclaw'
    );

    // The background processor would immediately pick tasks up and try to
    // reach a gateway; keep them pending so the tests stay hermetic.
    vi.spyOn(taskManager, 'getNextPending').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function queueTaskAs(ownerId: string, message: string): Promise<string> {
    const response = await handleOpenclawChatAsync(registry, { message }, ownerId);
    const task_id = json(response).task_id as string;
    expect(task_id).toBeTruthy();
    return task_id;
  }

  it('lets the owner read its own task', async () => {
    const taskId = await queueTaskAs(ALICE, 'hello');

    const response = await handleOpenclawTaskStatus(registry, { task_id: taskId }, ALICE);
    expect(response.isError).toBeUndefined();
    expect(json(response).task_id).toBe(taskId);
  });

  it("hides another connection's task behind the same 'not found' error", async () => {
    const taskId = await queueTaskAs(ALICE, 'confidential prompt');

    const response = await handleOpenclawTaskStatus(registry, { task_id: taskId }, MALLORY);
    expect(response.isError).toBe(true);
    expect(text(response)).toBe(`Error: Task not found: ${taskId}`);

    // Identical wording for an ID that never existed — no existence oracle.
    const unknown = await handleOpenclawTaskStatus(
      registry,
      { task_id: 'task_00000000-0000-4000-8000-000000000000' },
      MALLORY
    );
    expect(text(unknown)).toBe('Error: Task not found: task_00000000-0000-4000-8000-000000000000');
  });

  it("refuses to cancel another connection's task", async () => {
    const taskId = await queueTaskAs(ALICE, 'important work');

    const response = await handleOpenclawTaskCancel(registry, { task_id: taskId }, MALLORY);
    expect(response.isError).toBe(true);
    expect(text(response)).toBe(`Error: Task not found: ${taskId}`);

    // Still runnable for its actual owner.
    expect(taskManager.get(taskId, ALICE)?.status).toBe('pending');
  });

  it('lets the owner cancel its own task', async () => {
    const taskId = await queueTaskAs(ALICE, 'never mind');

    const response = await handleOpenclawTaskCancel(registry, { task_id: taskId }, ALICE);
    expect(response.isError).toBeUndefined();
    expect(taskManager.get(taskId, ALICE)?.status).toBe('cancelled');
  });

  it('scopes task_list and its stats to the calling connection', async () => {
    await queueTaskAs(ALICE, 'a1');
    await queueTaskAs(ALICE, 'a2');
    await queueTaskAs(MALLORY, 'm1');

    const alice = json(await handleOpenclawTaskList(registry, {}, ALICE));
    expect(alice.tasks).toHaveLength(2);
    expect((alice.stats as { total: number }).total).toBe(2);

    const mallory = json(await handleOpenclawTaskList(registry, {}, MALLORY));
    expect(mallory.tasks).toHaveLength(1);
    expect((mallory.stats as { total: number }).total).toBe(1);
  });

  it('does not leak across connections via the session_id filter', async () => {
    await handleOpenclawChatAsync(registry, { message: 'a', session_id: 'shared' }, ALICE);

    const mallory = json(await handleOpenclawTaskList(registry, { session_id: 'shared' }, MALLORY));
    expect(mallory.tasks).toHaveLength(0);
  });

  it('never exposes ownerId to the client', async () => {
    const taskId = await queueTaskAs(ALICE, 'hello');

    const status = text(await handleOpenclawTaskStatus(registry, { task_id: taskId }, ALICE));
    const list = text(await handleOpenclawTaskList(registry, {}, ALICE));

    expect(status).not.toContain(ALICE);
    expect(status).not.toContain('ownerId');
    expect(list).not.toContain(ALICE);
    expect(list).not.toContain('ownerId');
  });
});
