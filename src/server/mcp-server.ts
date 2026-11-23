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
import type { AuthInfo, ServerContext } from '@modelcontextprotocol/server';
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

export interface McpServerOptions {
  /**
   * Set by the HTTP transport when OAuth is on: every tool call must then carry
   * an authenticated OAuth client, and a call without one is refused instead of
   * falling back to the shared process owner.
   */
  authRequired?: boolean;
}

/**
 * Owner of every async task created without an authenticated principal: the
 * stdio transport, and HTTP with auth explicitly disabled
 * (MCP_DANGEROUSLY_DISABLE_AUTH). The stateless HTTP transport has no
 * per-connection identity to fall back to, so all such callers of one process
 * share a single task namespace.
 */
export const PROCESS_TASK_OWNER = 'process';

/**
 * Decide who owns the async tasks created or queried by a tool call.
 *
 * With OAuth enabled the owner is the authenticated OAuth client. Requests are
 * stateless, so this is what lets a client poll, list and cancel its own tasks
 * across separate HTTP requests while never seeing another client's. The OAuth
 * client is the right trust boundary because the bridge is single-tenant:
 * whoever holds the configured client's secret already has full chat access to
 * the same OpenClaw gateway. Dynamically registered clients
 * (MCP_DANGEROUSLY_ALLOW_DCR) each get their own client ID and therefore their
 * own owner.
 *
 * The `client:` prefix keeps the two namespaces apart: no client ID can ever
 * resolve to {@link PROCESS_TASK_OWNER}.
 */
export function resolveTaskOwner(authInfo: AuthInfo | undefined, authRequired = false): string {
  if (authInfo?.clientId) {
    return `client:${authInfo.clientId}`;
  }
  if (authRequired) {
    // Unreachable while requireBearerAuth guards /mcp. If that wiring ever
    // breaks, fail closed rather than pool every client's tasks together.
    throw new Error('Authenticated request carries no OAuth client identity');
  }
  return PROCESS_TASK_OWNER;
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
 * Create a new MCP server instance with all tools registered.
 */
export function createMcpServer(
  deps: ToolRegistrationDeps,
  options: McpServerOptions = {}
): McpServer {
  const { registry } = deps;
  const authRequired = options.authRequired === true;

  /**
   * Wrap a tool handler with logging, mirroring the v1 CallTool dispatch, and
   * hand it the task owner resolved from the request's validated access token.
   */
  const wrapHandler =
    (name: string, handler: (input: unknown, ownerId: string) => Promise<ToolResponse>) =>
    async (args: unknown, ctx: ServerContext): Promise<ToolResponse> => {
      log(`Executing tool: ${name}`);
      try {
        return await handler(args ?? {}, resolveTaskOwner(ctx.http?.authInfo, authRequired));
      } catch (error) {
        logError(`Error executing tool ${name}`, error);
        throw error;
      }
    };

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
    wrapHandler('openclaw_chat_async', (input, ownerId) =>
      tools.handleOpenclawChatAsync(registry, input, ownerId)
    )
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
    wrapHandler('openclaw_task_status', (input, ownerId) =>
      tools.handleOpenclawTaskStatus(registry, input, ownerId)
    )
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
    wrapHandler('openclaw_task_list', (input, ownerId) =>
      tools.handleOpenclawTaskList(registry, input, ownerId)
    )
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
    wrapHandler('openclaw_task_cancel', (input, ownerId) =>
      tools.handleOpenclawTaskCancel(registry, input, ownerId)
    )
  );

  return server;
}
