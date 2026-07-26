import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { taskManager } from '../../../mcp/tasks/manager.js';

// Suppress log output during tests
vi.spyOn(console, 'error').mockImplementation(() => {});

// Two independent MCP connections. Most tests use OWNER; OTHER exists to prove
// nothing leaks across the boundary.
const OWNER = 'owner-a';
const OTHER = 'owner-b';

describe('TaskManager', () => {
  beforeEach(() => {
    // Clean up all tasks before each test.
    // The taskManager is a singleton so we need to manually clear state.
    for (const owner of [OWNER, OTHER]) {
      for (const task of taskManager.list(owner)) {
        taskManager.delete(task.id);
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('create', () => {
    it('creates a task with pending status', () => {
      const task = taskManager.create({
        type: 'chat',
        input: { message: 'hello' },
        ownerId: OWNER,
      });
      expect(task.id).toMatch(/^task_/);
      expect(task.status).toBe('pending');
      expect(task.type).toBe('chat');
      expect(task.input).toEqual({ message: 'hello' });
      expect(task.priority).toBe(0);
      expect(task.createdAt).toBeInstanceOf(Date);
      expect(task.ownerId).toBe(OWNER);
    });

    it('assigns unique IDs', () => {
      const t1 = taskManager.create({ type: 'chat', input: 'a', ownerId: OWNER });
      const t2 = taskManager.create({ type: 'chat', input: 'b', ownerId: OWNER });
      expect(t1.id).not.toBe(t2.id);
    });

    it('assigns non-sequential, unguessable IDs', () => {
      const ids = Array.from({ length: 5 }, () =>
        taskManager.create({ type: 'chat', input: 'x', ownerId: OWNER })
      ).map((t) => t.id);

      // UUID suffix, not a counter an attacker could walk.
      for (const id of ids) {
        expect(id).toMatch(/^task_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('respects priority option', () => {
      const task = taskManager.create({ type: 'chat', input: 'x', priority: 5, ownerId: OWNER });
      expect(task.priority).toBe(5);
    });

    it('stores sessionId', () => {
      const task = taskManager.create({
        type: 'chat',
        input: 'x',
        sessionId: 'sess-1',
        ownerId: OWNER,
      });
      expect(task.sessionId).toBe('sess-1');
    });
  });

  describe('get', () => {
    it('returns task by ID for its owner', () => {
      const created = taskManager.create({ type: 'chat', input: 'test', ownerId: OWNER });
      const fetched = taskManager.get(created.id, OWNER);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(created.id);
    });

    it('returns undefined for unknown ID', () => {
      expect(taskManager.get('nonexistent', OWNER)).toBeUndefined();
    });

    it('hides tasks belonging to another owner', () => {
      const created = taskManager.create({ type: 'chat', input: 'secret', ownerId: OWNER });
      expect(taskManager.get(created.id, OTHER)).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns all tasks for the owner', () => {
      taskManager.create({ type: 'chat', input: '1', ownerId: OWNER });
      taskManager.create({ type: 'chat', input: '2', ownerId: OWNER });
      expect(taskManager.list(OWNER)).toHaveLength(2);
    });

    it('excludes tasks belonging to another owner', () => {
      taskManager.create({ type: 'chat', input: 'mine', ownerId: OWNER });
      taskManager.create({ type: 'chat', input: 'theirs', ownerId: OTHER });

      expect(taskManager.list(OWNER)).toHaveLength(1);
      expect(taskManager.list(OWNER)[0].input).toBe('mine');
      expect(taskManager.list(OTHER)).toHaveLength(1);
      expect(taskManager.list(OTHER)[0].input).toBe('theirs');
    });

    it('filters by status', () => {
      const t1 = taskManager.create({ type: 'chat', input: '1', ownerId: OWNER });
      taskManager.create({ type: 'chat', input: '2', ownerId: OWNER });
      taskManager.updateStatus(t1.id, 'running');

      expect(taskManager.list(OWNER, { status: 'running' })).toHaveLength(1);
      expect(taskManager.list(OWNER, { status: 'pending' })).toHaveLength(1);
    });

    it('filters by sessionId', () => {
      taskManager.create({ type: 'chat', input: '1', sessionId: 'a', ownerId: OWNER });
      taskManager.create({ type: 'chat', input: '2', sessionId: 'b', ownerId: OWNER });
      taskManager.create({ type: 'chat', input: '3', sessionId: 'a', ownerId: OWNER });

      expect(taskManager.list(OWNER, { sessionId: 'a' })).toHaveLength(2);
      expect(taskManager.list(OWNER, { sessionId: 'b' })).toHaveLength(1);
    });

    it('does not let a sessionId filter reach another owner', () => {
      taskManager.create({ type: 'chat', input: 'theirs', sessionId: 'shared', ownerId: OTHER });
      expect(taskManager.list(OWNER, { sessionId: 'shared' })).toHaveLength(0);
    });

    it('sorts by priority descending, then creation time ascending', () => {
      const low = taskManager.create({ type: 'chat', input: '1', priority: 1, ownerId: OWNER });
      const high = taskManager.create({ type: 'chat', input: '2', priority: 10, ownerId: OWNER });
      const mid = taskManager.create({ type: 'chat', input: '3', priority: 5, ownerId: OWNER });

      const sorted = taskManager.list(OWNER);
      expect(sorted[0].id).toBe(high.id);
      expect(sorted[1].id).toBe(mid.id);
      expect(sorted[2].id).toBe(low.id);
    });
  });

  describe('updateStatus', () => {
    it('changes task status', () => {
      const task = taskManager.create({ type: 'chat', input: 'test', ownerId: OWNER });
      const updated = taskManager.updateStatus(task.id, 'running');
      expect(updated).toBe(true);
      expect(taskManager.get(task.id, OWNER)?.status).toBe('running');
    });

    it('sets startedAt when moving to running', () => {
      const task = taskManager.create({ type: 'chat', input: 'test', ownerId: OWNER });
      taskManager.updateStatus(task.id, 'running');
      expect(taskManager.get(task.id, OWNER)?.startedAt).toBeInstanceOf(Date);
    });

    it('sets completedAt for terminal statuses', () => {
      const t1 = taskManager.create({ type: 'chat', input: '1', ownerId: OWNER });
      const t2 = taskManager.create({ type: 'chat', input: '2', ownerId: OWNER });
      const t3 = taskManager.create({ type: 'chat', input: '3', ownerId: OWNER });

      taskManager.updateStatus(t1.id, 'completed');
      taskManager.updateStatus(t2.id, 'failed');
      taskManager.updateStatus(t3.id, 'cancelled');

      expect(taskManager.get(t1.id, OWNER)?.completedAt).toBeInstanceOf(Date);
      expect(taskManager.get(t2.id, OWNER)?.completedAt).toBeInstanceOf(Date);
      expect(taskManager.get(t3.id, OWNER)?.completedAt).toBeInstanceOf(Date);
    });

    it('stores result and error', () => {
      const task = taskManager.create({ type: 'chat', input: 'test', ownerId: OWNER });
      taskManager.updateStatus(task.id, 'completed', 'result-data');
      expect(taskManager.get(task.id, OWNER)?.result).toBe('result-data');

      const task2 = taskManager.create({ type: 'chat', input: 'test2', ownerId: OWNER });
      taskManager.updateStatus(task2.id, 'failed', undefined, 'error-msg');
      expect(taskManager.get(task2.id, OWNER)?.error).toBe('error-msg');
    });

    it('returns false for unknown task', () => {
      expect(taskManager.updateStatus('nonexistent', 'running')).toBe(false);
    });
  });

  describe('cancel', () => {
    it('cancels a pending task', () => {
      const task = taskManager.create({ type: 'chat', input: 'test', ownerId: OWNER });
      expect(taskManager.cancel(task.id, OWNER)).toBe(true);
      expect(taskManager.get(task.id, OWNER)?.status).toBe('cancelled');
      expect(taskManager.get(task.id, OWNER)?.completedAt).toBeInstanceOf(Date);
    });

    it('rejects cancellation of non-pending task', () => {
      const task = taskManager.create({ type: 'chat', input: 'test', ownerId: OWNER });
      taskManager.updateStatus(task.id, 'running');
      expect(taskManager.cancel(task.id, OWNER)).toBe(false);
      expect(taskManager.get(task.id, OWNER)?.status).toBe('running');
    });

    it('returns false for unknown task', () => {
      expect(taskManager.cancel('nonexistent', OWNER)).toBe(false);
    });

    it("refuses to cancel another owner's task", () => {
      const task = taskManager.create({ type: 'chat', input: 'test', ownerId: OWNER });
      expect(taskManager.cancel(task.id, OTHER)).toBe(false);
      expect(taskManager.get(task.id, OWNER)?.status).toBe('pending');
    });
  });

  describe('getNextPending', () => {
    it('returns the highest-priority pending task', () => {
      taskManager.create({ type: 'chat', input: '1', priority: 1, ownerId: OWNER });
      const high = taskManager.create({ type: 'chat', input: '2', priority: 10, ownerId: OWNER });

      const next = taskManager.getNextPending();
      expect(next?.id).toBe(high.id);
    });

    it('returns undefined when no pending tasks', () => {
      const task = taskManager.create({ type: 'chat', input: '1', ownerId: OWNER });
      taskManager.updateStatus(task.id, 'running');
      expect(taskManager.getNextPending()).toBeUndefined();
    });

    it('serves every owner (worker path is intentionally unscoped)', () => {
      const theirs = taskManager.create({
        type: 'chat',
        input: 'theirs',
        priority: 10,
        ownerId: OTHER,
      });
      taskManager.create({ type: 'chat', input: 'mine', priority: 1, ownerId: OWNER });

      expect(taskManager.getNextPending()?.id).toBe(theirs.id);
    });
  });

  describe('cleanup', () => {
    it('removes completed tasks older than maxAge', () => {
      const task = taskManager.create({ type: 'chat', input: 'test', ownerId: OWNER });
      taskManager.updateStatus(task.id, 'completed');

      // Backdate the completedAt
      const t = taskManager.get(task.id, OWNER)!;
      t.completedAt = new Date(Date.now() - 7200_000); // 2 hours ago

      const cleaned = taskManager.cleanup(3600_000); // 1 hour threshold
      expect(cleaned).toBe(1);
      expect(taskManager.get(task.id, OWNER)).toBeUndefined();
    });

    it('keeps recent completed tasks', () => {
      const task = taskManager.create({ type: 'chat', input: 'test', ownerId: OWNER });
      taskManager.updateStatus(task.id, 'completed');

      const cleaned = taskManager.cleanup(3600_000);
      expect(cleaned).toBe(0);
      expect(taskManager.get(task.id, OWNER)).toBeDefined();
    });

    it('does not remove pending tasks', () => {
      taskManager.create({ type: 'chat', input: 'test', ownerId: OWNER });
      const cleaned = taskManager.cleanup(0);
      expect(cleaned).toBe(0);
    });
  });

  describe('stats', () => {
    it('returns correct counts', () => {
      const t1 = taskManager.create({ type: 'chat', input: '1', ownerId: OWNER });
      const t2 = taskManager.create({ type: 'chat', input: '2', ownerId: OWNER });
      taskManager.create({ type: 'chat', input: '3', ownerId: OWNER });

      taskManager.updateStatus(t1.id, 'running');
      taskManager.updateStatus(t2.id, 'completed');

      const stats = taskManager.stats(OWNER);
      expect(stats.total).toBe(3);
      expect(stats.byStatus.pending).toBe(1);
      expect(stats.byStatus.running).toBe(1);
      expect(stats.byStatus.completed).toBe(1);
      expect(stats.byStatus.failed).toBe(0);
      expect(stats.byStatus.cancelled).toBe(0);
    });

    it('returns zeros when empty', () => {
      const stats = taskManager.stats(OWNER);
      expect(stats.total).toBe(0);
      expect(stats.byStatus.pending).toBe(0);
    });

    it("does not count another owner's tasks", () => {
      taskManager.create({ type: 'chat', input: '1', ownerId: OTHER });
      taskManager.create({ type: 'chat', input: '2', ownerId: OTHER });

      const stats = taskManager.stats(OWNER);
      expect(stats.total).toBe(0);
      expect(stats.byStatus.pending).toBe(0);
    });
  });
});
