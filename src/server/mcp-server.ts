/**
 * MCP server factory (SDK v2).
 *
 * Builds an McpServer with all OpenClaw tools registered. Input schemas are
 * zod v4 (validated by the SDK before handlers run); handlers keep their own
 * defense-in-depth validation from src/utils/validation.ts.
 *
 * Both transports use this factory: stdio creates one instance for the
 * process, HTTP creates one per request (stateless).
 */

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { InstanceRegistry } from '../openclaw/registry.js';
import { SERVER_ICON_SVG_BASE64 } from '../config/constants.js';
import { log, logError } from '../utils/logger.js';
import type { ToolResponse } from '../utils/response-helpers.js';
import * as tools from '../mcp/tools/index.js';

export interface ToolRegistrationDeps {
  registry: InstanceRegistry;
  serverName: string;
  serverVersion: string;
}

const SERVER_ICONS = [
  {
    src: `data:image/svg+xml;base64,${SERVER_ICON_SVG_BASE64}`,
    mimeType: 'image/svg+xml',
    sizes: ['128x128'],
  },
];

const TASK_STATUS_VALUES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;

const instanceField = z
  .string()
  .optional()
  .describe(
    'Target OpenClaw instance name. Use openclaw_instances to list available instances. Defaults to the default instance.'
  );

/**
 * Wrap a tool handler with logging, mirroring the v1 CallTool dispatch.
 */
function wrapHandler(
  name: string,
  handler: (input: unknown) => Promise<ToolResponse>
): (args: unknown) => Promise<ToolResponse> {
  return async (args: unknown) => {
    log(`Executing tool: ${name}`);
    try {
      return await handler(args ?? {});
    } catch (error) {
      logError(`Error executing tool ${name}`, error);
      throw error;
    }
  };
}

/**
 * Create a new MCP server instance with all tools registered.
 */
export function createMcpServer(deps: ToolRegistrationDeps): McpServer {
  const { registry } = deps;

  const server = new McpServer(
    {
      name: deps.serverName,
      version: deps.serverVersion,
      icons: SERVER_ICONS,
    },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    'openclaw_chat',
    {
      description: 'Send a message to OpenClaw and get a response',
      inputSchema: z.object({
        message: z.string().describe('The message to send to OpenClaw'),
        session_id: z.string().optional().describe('Optional session ID for conversation context'),
        instance: instanceField,
      }),
    },
    wrapHandler('openclaw_chat', (input) => tools.handleOpenclawChat(registry, input))
  );

  server.registerTool(
    'openclaw_status',
    {
      description: 'Check OpenClaw gateway health',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instance: instanceField,
      }),
    },
    wrapHandler('openclaw_status', (input) => tools.handleOpenclawStatus(registry, input))
  );

  server.registerTool(
    'openclaw_instances',
    {
      description:
        'List all configured OpenClaw instances. Shows instance names, URLs, and which is the default. Use instance names in other tools to target a specific OpenClaw gateway.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    wrapHandler('openclaw_instances', (input) => tools.handleOpenclawInstances(registry, input))
  );

  server.registerTool(
    'openclaw_chat_async',
    {
      description:
        'Send a message to OpenClaw asynchronously. Returns a task_id immediately that can be polled for results. Use this for potentially long-running conversations.',
      inputSchema: z.object({
        message: z.string().describe('The message to send to OpenClaw'),
        session_id: z.string().optional().describe('Optional session ID for conversation context'),
        priority: z
          .number()
          .int()
          .optional()
          .describe('Task priority (higher = processed first). Default: 0'),
        instance: instanceField,
      }),
    },
    wrapHandler('openclaw_chat_async', (input) => tools.handleOpenclawChatAsync(registry, input))
  );

  server.registerTool(
    'openclaw_task_status',
    {
      description: 'Check the status of an async task. Returns status, and result if completed.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        task_id: z.string().describe('The task ID returned from openclaw_chat_async'),
      }),
    },
    wrapHandler('openclaw_task_status', (input) => tools.handleOpenclawTaskStatus(registry, input))
  );

  server.registerTool(
    'openclaw_task_list',
    {
      description: 'List all tasks. Optionally filter by status, session, or instance.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        status: z.enum(TASK_STATUS_VALUES).optional().describe('Filter by task status'),
        session_id: z.string().optional().describe('Filter by session ID'),
        instance: z.string().optional().describe('Filter by instance name'),
      }),
    },
    wrapHandler('openclaw_task_list', (input) => tools.handleOpenclawTaskList(registry, input))
  );

  server.registerTool(
    'openclaw_task_cancel',
    {
      description:
        'Cancel a pending or running task. Running tasks have their in-flight gateway request aborted.',
      inputSchema: z.object({
        task_id: z.string().describe('The task ID to cancel'),
      }),
    },
    wrapHandler('openclaw_task_cancel', (input) => tools.handleOpenclawTaskCancel(registry, input))
  );

  return server;
}
