/**
 * Async Task Tools for OpenClaw MCP
 *
 * Provides async/background task management for long-running operations.
 */

import type { InstanceRegistry } from '../../openclaw/registry.js';
import { successResponse, errorResponse, type ToolResponse } from '../../utils/response-helpers.js';
import { taskManager, type Task, type TaskStatus } from '../tasks/manager.js';
import { log } from '../../utils/logger.js';
import { validateInputIsObject, validateMessage, validateId } from '../../utils/validation.js';

// ============================================================================
// Background Task Processor
// ============================================================================

const DEFAULT_TASK_CONCURRENCY = 3;
const MAX_TASK_CONCURRENCY = 20;

let processorRunning = false;
let processorRegistry: InstanceRegistry | null = null;
const runningTasks = new Set<string>();

function resolveConcurrency(): number {
  const raw = process.env.OPENCLAW_TASK_CONCURRENCY;
  if (!raw) return DEFAULT_TASK_CONCURRENCY;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TASK_CONCURRENCY) {
    log(
      `Invalid OPENCLAW_TASK_CONCURRENCY="${raw}" (must be 1-${MAX_TASK_CONCURRENCY}), using ${DEFAULT_TASK_CONCURRENCY}`
    );
    return DEFAULT_TASK_CONCURRENCY;
  }
  return parsed;
}

async function processTask(task: Task, registry: InstanceRegistry): Promise<void> {
  taskManager.updateStatus(task.id, 'running');

  let client;
  try {
    client = registry.resolve(task.instanceId).client;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Instance not available';
    taskManager.updateStatus(task.id, 'failed', undefined, errorMsg);
    return;
  }

  const controller = new AbortController();
  taskManager.attachAbortController(task.id, controller);

  try {
    const input = task.input as { message: string; session_id?: string };
    // Stream so we see live progress: each delta proves the gateway is still
    // working, and the client's idle timeout replaces the absolute timeout.
    const response = await client.chat(input.message, {
      sessionId: input.session_id,
      signal: controller.signal,
      onDelta: (_delta, accumulated) => {
        taskManager.updateProgress(task.id, accumulated.length);
      },
    });
    // A cancel can land between the gateway resolving and this line; the
    // cancelled status must win, otherwise the caller is told the task was
    // cancelled and then sees it complete.
    if (taskManager.get(task.id)?.status === 'cancelled') {
      return;
    }
    taskManager.updateStatus(task.id, 'completed', response.response);
  } catch (error) {
    // A cancel aborts the request; don't overwrite the cancelled status.
    if (taskManager.get(task.id)?.status === 'cancelled') {
      return;
    }
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    taskManager.updateStatus(task.id, 'failed', undefined, errorMsg);
  }
}

async function taskProcessor(): Promise<void> {
  const concurrency = resolveConcurrency();
  log(`Task processor concurrency: ${concurrency}`);

  while (processorRunning) {
    while (runningTasks.size < concurrency && processorRegistry) {
      const task = taskManager.getNextPending();
      if (!task) break;

      runningTasks.add(task.id);
      void processTask(task, processorRegistry)
        .catch(() => {})
        .finally(() => runningTasks.delete(task.id));
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function startTaskProcessor(registry: InstanceRegistry): void {
  if (processorRunning) return;

  processorRegistry = registry;
  processorRunning = true;
  taskProcessor().catch(() => {
    processorRunning = false;
  });
  log('Task processor started');
}

// ============================================================================
// Tool Handlers
// ============================================================================

export async function handleOpenclawChatAsync(
  registry: InstanceRegistry,
  input: unknown
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }

  const msgResult = validateMessage(input.message);
  if (msgResult.valid === false) {
    return errorResponse(msgResult.error);
  }

  let sessionId: string | undefined;
  if (input.session_id !== undefined) {
    const sidResult = validateId(input.session_id, 'session_id');
    if (sidResult.valid === false) {
      return errorResponse(sidResult.error);
    }
    sessionId = sidResult.value;
  }

  let priority = 0;
  if (input.priority !== undefined) {
    if (typeof input.priority !== 'number' || !Number.isInteger(input.priority)) {
      return errorResponse('priority must be an integer');
    }
    priority = input.priority;
  }

  // Resolve instance name (validate it exists before queueing)
  let instanceId: string;
  try {
    let instanceName: string | undefined;
    if (input.instance !== undefined) {
      const instResult = validateId(input.instance, 'instance');
      if (instResult.valid === false) {
        return errorResponse(instResult.error);
      }
      instanceName = instResult.value;
    }
    const resolved = registry.resolve(instanceName);
    instanceId = resolved.name;
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Invalid instance');
  }

  // Ensure processor is running
  startTaskProcessor(registry);

  // Create task
  const task = taskManager.create({
    type: 'chat',
    input: { message: msgResult.value, session_id: sessionId },
    sessionId,
    priority,
    instanceId,
  });

  return successResponse(
    JSON.stringify(
      {
        task_id: task.id,
        status: task.status,
        instance: instanceId,
        message: 'Task queued. Use openclaw_task_status to check progress.',
      },
      null,
      2
    )
  );
}

export async function handleOpenclawTaskStatus(
  _registry: InstanceRegistry,
  input: unknown
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }

  const tidResult = validateId(input.task_id, 'task_id');
  if (tidResult.valid === false) {
    return errorResponse(tidResult.error);
  }
  const task_id = tidResult.value;

  const task = taskManager.get(task_id);
  if (!task) {
    return errorResponse(`Task not found: ${task_id}`);
  }

  const response: Record<string, unknown> = {
    task_id: task.id,
    type: task.type,
    status: task.status,
    instance: task.instanceId,
    created_at: task.createdAt.toISOString(),
  };

  if (task.startedAt) {
    response.started_at = task.startedAt.toISOString();
  }
  if (task.status === 'running' && task.progressChars !== undefined) {
    response.progress_chars = task.progressChars;
    response.last_activity_at = task.lastActivityAt?.toISOString();
  }
  if (task.completedAt) {
    response.completed_at = task.completedAt.toISOString();
  }
  if (task.status === 'completed' && task.result) {
    response.result = task.result;
  }
  if (task.status === 'failed' && task.error) {
    response.error = task.error;
  }

  return successResponse(JSON.stringify(response, null, 2));
}

const VALID_TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
];

export async function handleOpenclawTaskList(
  _registry: InstanceRegistry,
  input: unknown
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }

  let status: TaskStatus | undefined;
  if (input.status !== undefined) {
    if (
      typeof input.status !== 'string' ||
      !VALID_TASK_STATUSES.includes(input.status as TaskStatus)
    ) {
      return errorResponse(`status must be one of: ${VALID_TASK_STATUSES.join(', ')}`);
    }
    status = input.status as TaskStatus;
  }

  let session_id: string | undefined;
  if (input.session_id !== undefined) {
    const sidResult = validateId(input.session_id, 'session_id');
    if (sidResult.valid === false) {
      return errorResponse(sidResult.error);
    }
    session_id = sidResult.value;
  }

  let instanceFilter: string | undefined;
  if (input.instance !== undefined) {
    const instResult = validateId(input.instance, 'instance');
    if (instResult.valid === false) {
      return errorResponse(instResult.error);
    }
    instanceFilter = instResult.value;
  }

  const tasks = taskManager.list({ status, sessionId: session_id, instanceId: instanceFilter });
  const stats = taskManager.stats();

  const taskList = tasks.map((t) => ({
    task_id: t.id,
    type: t.type,
    status: t.status,
    instance: t.instanceId,
    priority: t.priority,
    created_at: t.createdAt.toISOString(),
    has_result: t.status === 'completed' && !!t.result,
  }));

  return successResponse(
    JSON.stringify(
      {
        stats,
        tasks: taskList,
      },
      null,
      2
    )
  );
}

export async function handleOpenclawTaskCancel(
  _registry: InstanceRegistry,
  input: unknown
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }

  const tidResult = validateId(input.task_id, 'task_id');
  if (tidResult.valid === false) {
    return errorResponse(tidResult.error);
  }
  const task_id = tidResult.value;

  const task = taskManager.get(task_id);
  if (!task) {
    return errorResponse(`Task not found: ${task_id}`);
  }

  if (task.status !== 'pending' && task.status !== 'running') {
    return errorResponse(
      `Cannot cancel task with status: ${task.status}. Only pending or running tasks can be cancelled.`
    );
  }

  const cancelled = taskManager.cancel(task_id);
  if (!cancelled) {
    return errorResponse('Failed to cancel task');
  }

  return successResponse(
    JSON.stringify(
      {
        task_id,
        status: 'cancelled',
        message: 'Task cancelled successfully',
      },
      null,
      2
    )
  );
}
