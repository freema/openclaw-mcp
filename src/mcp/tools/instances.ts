import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InstanceRegistry } from '../../openclaw/registry.js';
import { jsonResponse, type ToolResponse } from '../../utils/response-helpers.js';

export const openclawInstancesTool: Tool = {
  name: 'openclaw_instances',
  description:
    'List all configured OpenClaw instances. Shows instance names, URLs, and which is the default. Use instance names in other tools to target a specific OpenClaw gateway.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export async function handleOpenclawInstances(
  registry: InstanceRegistry,
  _input: unknown
): Promise<ToolResponse> {
  return jsonResponse({
    instances: registry.list(),
    total: registry.size,
  });
}
