import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InstanceRegistry } from '../../openclaw/registry.js';
import { successResponse, errorResponse, type ToolResponse } from '../../utils/response-helpers.js';
import { validateInputIsObject, validateMessage, validateId } from '../../utils/validation.js';

export const openclawChatTool: Tool = {
  name: 'openclaw_chat',
  description: 'Send a message to OpenClaw and get a response',
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
      instance: {
        type: 'string',
        description:
          'Target OpenClaw instance name. Use openclaw_instances to list available instances. Defaults to the default instance.',
      },
    },
    required: ['message'],
  },
};

export async function handleOpenclawChat(
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

  let instanceName: string | undefined;
  if (input.instance !== undefined) {
    const instResult = validateId(input.instance, 'instance');
    if (instResult.valid === false) {
      return errorResponse(instResult.error);
    }
    instanceName = instResult.value;
  }

  try {
    const { client } = registry.resolve(instanceName);
    const response = await client.chat(msgResult.value, sessionId);
    return successResponse(response.response);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to chat with OpenClaw');
  }
}
