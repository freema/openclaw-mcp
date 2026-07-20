import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { taskManager } from '../../../mcp/tasks/manager.js';

// Suppress log output during tests
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('TaskManager', () => {
  beforeEach(() => {
    // Clean up all tasks before each test.
    // The taskManager is a singleton so we need to manually clear state.
    const allTasks = taskManager.list();
    for (const task of allTasks) {
      taskManager.delete(task.id);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('create', () => {
    it('creates a task with pending status', () => {
      const task = taskManager.create({ type: 'chat', input: { message: 'hello' } });
      expect(task.id).toMatch(/^task_/);
      expect(task.status).toBe('pending');
      expect(task.type).toBe('chat');
      expect(task.input).toEqual({ message: 'hello' });
      expect(task.priority).toBe(0);
      expect(task.createdAt).toBeInstanceOf(Date);
    });

    it('assigns unique IDs', () => {
      const t1 = taskManager.create({ type: 'chat', input: 'a' });
      const t2 = taskManager.create({ type: 'chat', input: 'b' });
      expect(t1.id).not.toBe(t2.id);
    });

    it('respects priority option', () => {
      const task = taskManager.create({ type: 'chat', input: 'x', priority: 5 });
      expect(task.priority).toBe(5);
    });

    it('stores sessionId', () => {
      const task = taskManager.create({
        type: 'chat',
        input: 'x',
        sessionId: 'sess-1',
      });
      expect(task.sessionId).toBe('sess-1');
    });
  });

  describe('get', () => {
    it('returns task by ID', () => {
      const created = taskManager.create({ type: 'chat', input: 'test' });
      const fetched = taskManager.get(created.id);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(created.id);
    });

    it('returns undefined for unknown ID', () => {
      expect(taskManager.get('nonexistent')).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns all tasks', () => {
      taskManager.create({ type: 'chat', input: '1' });
      taskManager.create({ type: 'chat', input: '2' });
      expect(taskManager.list()).toHaveLength(2);
    });

    it('filters by status', () => {
      const t1 = taskManager.create({ type: 'chat', input: '1' });
      taskManager.create({ type: 'chat', input: '2' });
      taskManager.updateStatus(t1.id, 'running');

      expect(taskManager.list({ status: 'running' })).toHaveLength(1);
      expect(taskManager.list({ status: 'pending' })).toHaveLength(1);
    });

    it('filters by sessionId', () => {
      taskManager.create({ type: 'chat', input: '1', sessionId: 'a' });
      taskManager.create({ type: 'chat', input: '2', sessionId: 'b' });
      taskManager.create({ type: 'chat', input: '3', sessionId: 'a' });

      expect(taskManager.list({ sessionId: 'a' })).toHaveLength(2);
      expect(taskManager.list({ sessionId: 'b' })).toHaveLength(1);
    });

    it('sorts by priority descending, then creation time ascending', () => {
      const low = taskManager.create({ type: 'chat', input: '1', priority: 1 });
      const high = taskManager.create({ type: 'chat', input: '2', priority: 10 });
      const mid = taskManager.create({ type: 'chat', input: '3', priority: 5 });

      const sorted = taskManager.list();
      expect(sorted[0].id).toBe(high.id);
      expect(sorted[1].id).toBe(mid.id);
      expect(sorted[2].id).toBe(low.id);
    });
  });

  describe('updateStatus', () => {
    it('changes task status', () => {
      const task = taskManager.create({ type: 'chat', input: 'test' });
      const updated = taskManager.updateStatus(task.id, 'running');
      expect(updated).toBe(true);
      expect(taskManager.get(task.id)?.status).toBe('running');
    });

    it('sets startedAt when moving to running', () => {
      const task = taskManager.create({ type: 'chat', input: 'test' });
      taskManager.updateStatus(task.id, 'running');
      expect(taskManager.get(task.id)?.startedAt).toBeInstanceOf(Date);
    });

    it('sets completedAt for terminal statuses', () => {
      const t1 = taskManager.create({ type: 'chat', input: '1' });
      const t2 = taskManager.create({ type: 'chat', input: '2' });
      const t3 = taskManager.create({ type: 'chat', input: '3' });

      taskManager.updateStatus(t1.id, 'completed');
      taskManager.updateStatus(t2.id, 'failed');
      taskManager.updateStatus(t3.id, 'cancelled');

      expect(taskManager.get(t1.id)?.completedAt).toBeInstanceOf(Date);
      expect(taskManager.get(t2.id)?.completedAt).toBeInstanceOf(Date);
      expect(taskManager.get(t3.id)?.completedAt).toBeInstanceOf(Date);
    });

    it('stores result and error', () => {
      const task = taskManager.create({ type: 'chat', input: 'test' });
      taskManager.updateStatus(task.id, 'completed', 'result-data');
      expect(taskManager.get(task.id)?.result).toBe('result-data');

      const task2 = taskManager.create({ type: 'chat', input: 'test2' });
      taskManager.updateStatus(task2.id, 'failed', undefined, 'error-msg');
      expect(taskManager.get(task2.id)?.error).toBe('error-msg');
    });

    it('returns false for unknown task', () => {
      expect(taskManager.updateStatus('nonexistent', 'running')).toBe(false);
    });
  });

  describe('cancel', () => {
    it('cancels a pending task', () => {
      const task = taskManager.create({ type: 'chat', input: 'test' });
      expect(taskManager.cancel(task.id)).toBe(true);
      expect(taskManager.get(task.id)?.status).toBe('cancelled');
      expect(taskManager.get(task.id)?.completedAt).toBeInstanceOf(Date);
    });

    it('cancels a running task and aborts its request', () => {
      const task = taskManager.create({ type: 'chat', input: 'test' });
      taskManager.updateStatus(task.id, 'running');
      const controller = new AbortController();
      taskManager.attachAbortController(task.id, controller);

      expect(taskManager.cancel(task.id)).toBe(true);
      expect(taskManager.get(task.id)?.status).toBe('cancelled');
      expect(controller.signal.aborted).toBe(true);
    });

    it('rejects cancellation of a finished task', () => {
      const task = taskManager.create({ type: 'chat', input: 'test' });
      taskManager.updateStatus(task.id, 'completed', 'done');
      expect(taskManager.cancel(task.id)).toBe(false);
      expect(taskManager.get(task.id)?.status).toBe('completed');
    });

    it('returns false for unknown task', () => {
      expect(taskManager.cancel('nonexistent')).toBe(false);
    });
  });

  describe('getNextPending', () => {
    it('returns the highest-priority pending task', () => {
      taskManager.create({ type: 'chat', input: '1', priority: 1 });
      const high = taskManager.create({ type: 'chat', input: '2', priority: 10 });

      const next = taskManager.getNextPending();
      expect(next?.id).toBe(high.id);
    });

    it('returns undefined when no pending tasks', () => {
      const task = taskManager.create({ type: 'chat', input: '1' });
      taskManager.updateStatus(task.id, 'running');
      expect(taskManager.getNextPending()).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('removes completed tasks older than maxAge', () => {
      const task = taskManager.create({ type: 'chat', input: 'test' });
      taskManager.updateStatus(task.id, 'completed');

      // Backdate the completedAt
      const t = taskManager.get(task.id)!;
      t.completedAt = new Date(Date.now() - 7200_000); // 2 hours ago

      const cleaned = taskManager.cleanup(3600_000); // 1 hour threshold
      expect(cleaned).toBe(1);
      expect(taskManager.get(task.id)).toBeUndefined();
    });

    it('keeps recent completed tasks', () => {
      const task = taskManager.create({ type: 'chat', input: 'test' });
      taskManager.updateStatus(task.id, 'completed');

      const cleaned = taskManager.cleanup(3600_000);
      expect(cleaned).toBe(0);
      expect(taskManager.get(task.id)).toBeDefined();
    });

    it('does not remove pending tasks', () => {
      taskManager.create({ type: 'chat', input: 'test' });
      const cleaned = taskManager.cleanup(0);
      expect(cleaned).toBe(0);
    });
  });

  describe('stats', () => {
    it('returns correct counts', () => {
      const t1 = taskManager.create({ type: 'chat', input: '1' });
      const t2 = taskManager.create({ type: 'chat', input: '2' });
      taskManager.create({ type: 'chat', input: '3' });

      taskManager.updateStatus(t1.id, 'running');
      taskManager.updateStatus(t2.id, 'completed');

      const stats = taskManager.stats();
      expect(stats.total).toBe(3);
      expect(stats.byStatus.pending).toBe(1);
      expect(stats.byStatus.running).toBe(1);
      expect(stats.byStatus.completed).toBe(1);
      expect(stats.byStatus.failed).toBe(0);
      expect(stats.byStatus.cancelled).toBe(0);
    });

    it('returns zeros when empty', () => {
      const stats = taskManager.stats();
      expect(stats.total).toBe(0);
      expect(stats.byStatus.pending).toBe(0);
    });
  });
});
