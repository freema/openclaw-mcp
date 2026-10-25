/**
 * Shared tool registration for MCP Server instances.
 *
 * Each HTTP connection needs its own Server + Transport pair,
 * but they all register the same set of tools. This module extracts
 * that registration logic into a reusable function.
 */

import { randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import type { InstanceRegistry } from '../openclaw/registry.js';
import { SERVER_ICON_SVG_BASE64 } from '../config/constants.js';
import { log, logError } from '../utils/logger.js';
import * as tools from '../mcp/tools/index.js';

export interface ToolRegistrationDeps {
  registry: InstanceRegistry;
  serverName: string;
  serverVersion: string;
}

/**
 * Decide who owns the async tasks created or queried by a tool call.
 *
 * With OAuth enabled the owner is the authenticated OAuth client, not the MCP
 * connection, so a client that opens a new session between tool calls can
 * still poll the tasks it created (#44). The OAuth client is the right trust
 * boundary because the bridge is single-tenant: whoever holds the configured
 * client's secret already has full chat access to the same OpenClaw gateway.
 * Dynamically registered clients (MCP_DANGEROUSLY_ALLOW_DCR) each get their own
 * client ID and therefore their own owner, so a freshly registered client
 * still cannot see anyone else's tasks.
 *
 * Without an authenticated principal (stdio, or HTTP with auth explicitly
 * disabled) ownership falls back to the per-connection ID.
 */
export function resolveTaskOwner(
  authInfo: AuthInfo | undefined,
  connectionOwnerId: string
): string {
  return authInfo?.clientId ? `client:${authInfo.clientId}` : `connection:${connectionOwnerId}`;
}

/**
 * Create a new MCP Server instance with all tools registered.
 */
export function createMcpServer(deps: ToolRegistrationDeps): Server {
  const server = new Server(
    {
      name: deps.serverName,
      version: deps.serverVersion,
      icons: [
        {
          src: `data:image/svg+xml;base64,${SERVER_ICON_SVG_BASE64}`,
          mimeType: 'image/svg+xml',
          sizes: ['128x128'],
        },
      ],
    },
    { capabilities: { tools: {} } }
  );

  registerTools(server, deps);
  return server;
}

/**
 * Register all OpenClaw tools on an existing MCP Server instance.
 */
function registerTools(server: Server, deps: ToolRegistrationDeps): void {
  const { registry } = deps;

  // Fallback identity for callers without an authenticated principal.
  //
  // In stdio mode there is exactly one Server for the process lifetime, so this
  // is the only owner. Unauthenticated HTTP has no identity to bind to, so each
  // connection gets its own namespace and cannot reach another connection's
  // tasks (it also cannot resume its own tasks after reconnecting).
  const connectionOwnerId = randomUUID();

  const toolHandlers = new Map<
    string,
    (
      input: unknown,
      ownerId: string
    ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
  >([
    ['openclaw_chat', (input) => tools.handleOpenclawChat(registry, input)],
    ['openclaw_status', (input) => tools.handleOpenclawStatus(registry, input)],
    [
      'openclaw_chat_async',
      (input, ownerId) => tools.handleOpenclawChatAsync(registry, input, ownerId),
    ],
    [
      'openclaw_task_status',
      (input, ownerId) => tools.handleOpenclawTaskStatus(registry, input, ownerId),
    ],
    [
      'openclaw_task_list',
      (input, ownerId) => tools.handleOpenclawTaskList(registry, input, ownerId),
    ],
    [
      'openclaw_task_cancel',
      (input, ownerId) => tools.handleOpenclawTaskCancel(registry, input, ownerId),
    ],
    ['openclaw_instances', (input) => tools.handleOpenclawInstances(registry, input)],
  ]);

  const allTools = [
    tools.openclawChatTool,
    tools.openclawStatusTool,
    tools.openclawChatAsyncTool,
    tools.openclawTaskStatusTool,
    tools.openclawTaskListTool,
    tools.openclawTaskCancelTool,
    tools.openclawInstancesTool,
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: toolArgs } = request.params;
    log(`Executing tool: ${name}`);

    const handler = toolHandlers.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      return await handler(toolArgs, resolveTaskOwner(extra.authInfo, connectionOwnerId));
    } catch (error) {
      logError(`Error executing tool ${name}`, error);
      throw error;
    }
  });
}
