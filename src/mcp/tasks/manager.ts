/**
 * Task Manager for async operations
 *
 * Manages background tasks with status tracking, allowing
 * long-running operations to be started and polled for results.
 *
 * Ownership
 * ---------
 * The manager is a process-wide singleton, but in HTTP mode a single process
 * serves many independent MCP connections. Every task is therefore tagged with
 * the `ownerId` of the connection that created it, and every read/write path
 * reachable from a tool handler requires that same `ownerId`. A caller can
 * never observe or mutate a task belonging to another connection, even when it
 * knows (or guesses) the task ID.
 */

import { randomUUID } from 'node:crypto';

import { log } from '../../utils/logger.js';

const MAX_TASKS = 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  type: 'chat';
  status: TaskStatus;
  input: unknown;
  result?: string;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  /** Connection that owns this task. Never exposed to clients. */
  ownerId: string;
  sessionId?: string;
  instanceId?: string;
  priority: number;
  /** Streamed characters received so far (running tasks). */
  progressChars?: number;
  /** Last streamed activity — proof the gateway is still working. */
  lastActivityAt?: Date;
  /** Aborts the in-flight gateway request when a running task is cancelled. */
  abortController?: AbortController;
}

export interface TaskCreateOptions {
  type: 'chat';
  input: unknown;
  /** Connection creating the task — required, see "Ownership" above. */
  ownerId: string;
  sessionId?: string;
  instanceId?: string;
  priority?: number;
}

class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(CLEANUP_MAX_AGE_MS), CLEANUP_INTERVAL_MS);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Generate an unguessable task ID.
   *
   * Deliberately not sequential: a predictable counter would let a caller
   * enumerate IDs and probe for tasks it does not own. Ownership checks are
   * the real defence, this just removes the oracle.
   */
  private generateId(): string {
    return `task_${randomUUID()}`;
  }

  /**
   * Create a new task owned by `options.ownerId`.
   */
  create(options: TaskCreateOptions): Task {
    if (this.tasks.size >= MAX_TASKS) {
      throw new Error(
        `Task limit reached (${MAX_TASKS}). Wait for tasks to complete or cancel pending ones.`
      );
    }

    const id = this.generateId();
    const task: Task = {
      id,
      type: options.type,
      status: 'pending',
      input: options.input,
      createdAt: new Date(),
      ownerId: options.ownerId,
      sessionId: options.sessionId,
      instanceId: options.instanceId,
      priority: options.priority ?? 0,
    };

    this.tasks.set(id, task);
    log(`Task created: ${id} (type: ${task.type})`);
    return task;
  }

  /**
   * Get a task by ID, but only if `ownerId` owns it.
   *
   * Returns undefined both for unknown IDs and for tasks owned by someone
   * else, so callers cannot distinguish the two.
   */
  get(id: string, ownerId: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task || task.ownerId !== ownerId) return undefined;
    return task;
  }

  /**
   * List the tasks owned by `ownerId`, optionally filtered further.
   */
  list(
    ownerId: string,
    filter?: { status?: TaskStatus; sessionId?: string; instanceId?: string }
  ): Task[] {
    let tasks = Array.from(this.tasks.values()).filter((t) => t.ownerId === ownerId);

    if (filter?.status) {
      tasks = tasks.filter((t) => t.status === filter.status);
    }
    if (filter?.sessionId) {
      tasks = tasks.filter((t) => t.sessionId === filter.sessionId);
    }
    if (filter?.instanceId) {
      tasks = tasks.filter((t) => t.instanceId === filter.instanceId);
    }

    // Sort by priority (desc) then creation time (asc)
    return tasks.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  /**
   * Update task status.
   *
   * Internal worker path only — never reachable from a tool handler, so it
   * takes no ownerId.
   */
  updateStatus(id: string, status: TaskStatus, result?: string, error?: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    task.status = status;

    if (status === 'running' && !task.startedAt) {
      task.startedAt = new Date();
      // Seed progress immediately so a running task always reports liveness,
      // even before the first content delta arrives.
      task.progressChars = 0;
      task.lastActivityAt = task.startedAt;
    }

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      task.completedAt = new Date();
    }

    if (result !== undefined) task.result = result;
    if (error !== undefined) task.error = error;

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      task.abortController = undefined;
    }

    log(`Task ${id} status: ${status}`);
    return true;
  }

  /**
   * Record streaming progress for a running task. Pass no character count to
   * record liveness only (a heartbeat with no new content).
   *
   * Internal only — driven by the streaming loop that already owns the task,
   * so it takes no ownerId.
   */
  updateProgress(id: string, progressChars?: number): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return false;

    if (progressChars !== undefined) {
      task.progressChars = progressChars;
    }
    task.lastActivityAt = new Date();
    return true;
  }

  /**
   * Attach the abort controller of the in-flight request to a task.
   *
   * Internal only — called on the path that just started the request, so it
   * takes no ownerId.
   */
  attachAbortController(id: string, controller: AbortController): void {
    const task = this.tasks.get(id);
    if (task) task.abortController = controller;
  }

  /**
   * Cancel a pending or running task owned by `ownerId`. Running tasks have
   * their in-flight gateway request aborted.
   */
  cancel(id: string, ownerId: string): boolean {
    const task = this.get(id, ownerId);
    if (!task) return false;

    if (task.status !== 'pending' && task.status !== 'running') {
      return false; // Already finished
    }

    const controller = task.abortController;
    task.status = 'cancelled';
    task.completedAt = new Date();
    task.abortController = undefined;
    controller?.abort();
    log(`Task cancelled: ${id}`);
    return true;
  }

  /**
   * Delete a task (cleanup). Internal only.
   */
  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  /**
   * Get next pending task across all owners (for the background worker).
   *
   * Internal only — the worker has to see every queue, which is exactly why
   * tool handlers must go through the owner-scoped methods instead.
   */
  getNextPending(): Task | undefined {
    const pending = Array.from(this.tasks.values())
      .filter((t) => t.status === 'pending')
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
    return pending[0];
  }

  /**
   * Clean up old completed/failed tasks
   */
  cleanup(maxAgeMs: number = 3600000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, task] of this.tasks) {
      if (task.completedAt && now - task.completedAt.getTime() > maxAgeMs) {
        this.tasks.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log(`Cleaned up ${cleaned} old tasks`);
    }
    return cleaned;
  }

  /**
   * Get statistics for the tasks owned by `ownerId`.
   *
   * Scoped like everything else: a global total would leak how busy other
   * connections are.
   */
  stats(ownerId: string): { total: number; byStatus: Record<TaskStatus, number> } {
    const byStatus: Record<TaskStatus, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    let total = 0;
    for (const task of this.tasks.values()) {
      if (task.ownerId !== ownerId) continue;
      byStatus[task.status]++;
      total++;
    }

    return { total, byStatus };
  }
}

// Singleton instance
export const taskManager = new TaskManager();
