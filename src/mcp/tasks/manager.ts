/**
 * Task Manager for async operations
 *
 * Manages background tasks with status tracking, allowing
 * long-running operations to be started and polled for results.
 */

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
  sessionId?: string;
  instanceId?: string;
  priority?: number;
}

class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private taskCounter = 0;
  private cleanupInterval: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(CLEANUP_MAX_AGE_MS), CLEANUP_INTERVAL_MS);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Generate unique task ID
   */
  private generateId(): string {
    this.taskCounter++;
    const timestamp = Date.now().toString(36);
    const counter = this.taskCounter.toString(36).padStart(4, '0');
    return `task_${timestamp}_${counter}`;
  }

  /**
   * Create a new task
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
      sessionId: options.sessionId,
      instanceId: options.instanceId,
      priority: options.priority ?? 0,
    };

    this.tasks.set(id, task);
    log(`Task created: ${id} (type: ${task.type})`);
    return task;
  }

  /**
   * Get task by ID
   */
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /**
   * List all tasks, optionally filtered by status
   */
  list(filter?: { status?: TaskStatus; sessionId?: string; instanceId?: string }): Task[] {
    let tasks = Array.from(this.tasks.values());

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
   * Update task status
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
   * Attach the abort controller of the in-flight request to a task
   */
  attachAbortController(id: string, controller: AbortController): void {
    const task = this.tasks.get(id);
    if (task) task.abortController = controller;
  }

  /**
   * Cancel a pending or running task. Running tasks have their
   * in-flight gateway request aborted.
   */
  cancel(id: string): boolean {
    const task = this.tasks.get(id);
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
   * Delete a task (cleanup)
   */
  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  /**
   * Get next pending task (for workers)
   */
  getNextPending(): Task | undefined {
    const pending = this.list({ status: 'pending' });
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
   * Get statistics
   */
  stats(): { total: number; byStatus: Record<TaskStatus, number> } {
    const byStatus: Record<TaskStatus, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const task of this.tasks.values()) {
      byStatus[task.status]++;
    }

    return {
      total: this.tasks.size,
      byStatus,
    };
  }
}

// Singleton instance
export const taskManager = new TaskManager();
