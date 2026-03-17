import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InstanceRegistry } from '../../openclaw/registry.js';
import { jsonResponse, errorResponse, type ToolResponse } from '../../utils/response-helpers.js';
import { validateInputIsObject, validateId } from '../../utils/validation.js';

export const openclawStatusTool: Tool = {
  name: 'openclaw_status',
  description: 'Get OpenClaw gateway status and health information',
  inputSchema: {
    type: 'object',
    properties: {
      instance: {
        type: 'string',
        description: 'Target OpenClaw instance name. Defaults to the default instance.',
      },
    },
  },
};

export async function handleOpenclawStatus(
  registry: InstanceRegistry,
  input: unknown
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }

  let instanceName: string | undefined;
  if (input.instance !== undefined) {
    const instResult = validateId(input.instance, 'instance');
    if (instResult.valid === false) {
      return errorResponse(instResult.error);
    }
    instanceName = instResult.value;
  }

  try {
    const resolved = registry.resolve(instanceName);
    const response = await resolved.client.health();
    return jsonResponse({
      ...response,
      instance: resolved.name,
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to get status from OpenClaw'
    );
  }
}
