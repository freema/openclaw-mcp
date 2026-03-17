/**
 * Async Task Tools for OpenClaw MCP
 *
 * Provides async/background task management for long-running operations.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InstanceRegistry } from '../../openclaw/registry.js';
import { successResponse, errorResponse, type ToolResponse } from '../../utils/response-helpers.js';
import { taskManager, type Task, type TaskStatus } from '../tasks/manager.js';
import { log } from '../../utils/logger.js';
import { validateInputIsObject, validateMessage, validateId } from '../../utils/validation.js';

// ============================================================================
// Tool Definitions
// ============================================================================

export const openclawChatAsyncTool: Tool = {
  name: 'openclaw_chat_async',
  description:
    'Send a message to OpenClaw asynchronously. Returns a task_id immediately that can be polled for results. Use this for potentially long-running conversations.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to send to OpenClaw',
      },
      session_id: {
        type: 'string',
        description: 'Optional session ID for conversation context',
      },
      priority: {
        type: 'number',
        description: 'Task priority (higher = processed first). Default: 0',
      },
      instance: {
        type: 'string',
        description: 'Target OpenClaw instance name. Defaults to the default instance.',
      },
    },
    required: ['message'],
  },
};

export const openclawTaskStatusTool: Tool = {
  name: 'openclaw_task_status',
  description: 'Check the status of an async task. Returns status, and result if completed.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The task ID returned from openclaw_chat_async',
      },
    },
    required: ['task_id'],
  },
};

export const openclawTaskListTool: Tool = {
  name: 'openclaw_task_list',
  description: 'List all tasks. Optionally filter by status, session, or instance.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
        description: 'Filter by task status',
      },
      session_id: {
        type: 'string',
        description: 'Filter by session ID',
      },
      instance: {
        type: 'string',
        description: 'Filter by instance name',
      },
    },
    required: [],
  },
};

export const openclawTaskCancelTool: Tool = {
  name: 'openclaw_task_cancel',
  description: "Cancel a pending task. Only works for tasks that haven't started yet.",
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The task ID to cancel',
      },
    },
    required: ['task_id'],
  },
};

// ============================================================================
// Background Task Processor
// ============================================================================

let processorRunning = false;
let processorRegistry: InstanceRegistry | null = null;

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

  try {
    const input = task.input as { message: string; session_id?: string };
    const response = await client.chat(input.message, input.session_id);
    taskManager.updateStatus(task.id, 'completed', response.response);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    taskManager.updateStatus(task.id, 'failed', undefined, errorMsg);
  }
}

async function taskProcessor(): Promise<void> {
  if (!processorRegistry) return;

  while (processorRunning) {
    const task = taskManager.getNextPending();

    if (task) {
      await processTask(task, processorRegistry);
    } else {
      // No pending tasks, wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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

  if (task.status !== 'pending') {
    return errorResponse(
      `Cannot cancel task with status: ${task.status}. Only pending tasks can be cancelled.`
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
