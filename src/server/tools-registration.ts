/**
 * Shared tool registration for MCP Server instances.
 *
 * Each SSE/Streamable HTTP connection needs its own Server + Transport pair,
 * but they all register the same set of tools. This module extracts
 * that registration logic into a reusable function.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

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

  const toolHandlers = new Map<
    string,
    (
      input: unknown
    ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
  >([
    ['openclaw_chat', (input) => tools.handleOpenclawChat(registry, input)],
    ['openclaw_status', (input) => tools.handleOpenclawStatus(registry, input)],
    ['openclaw_chat_async', (input) => tools.handleOpenclawChatAsync(registry, input)],
    ['openclaw_task_status', (input) => tools.handleOpenclawTaskStatus(registry, input)],
    ['openclaw_task_list', (input) => tools.handleOpenclawTaskList(registry, input)],
    ['openclaw_task_cancel', (input) => tools.handleOpenclawTaskCancel(registry, input)],
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    log(`Executing tool: ${name}`);

    const handler = toolHandlers.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      return await handler(toolArgs);
    } catch (error) {
      logError(`Error executing tool ${name}`, error);
      throw error;
    }
  });
}
