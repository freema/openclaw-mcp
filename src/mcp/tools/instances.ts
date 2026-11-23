import type { InstanceRegistry } from '../../openclaw/registry.js';
import { jsonResponse, type ToolResponse } from '../../utils/response-helpers.js';

export async function handleOpenclawInstances(
  registry: InstanceRegistry,
  _input: unknown
): Promise<ToolResponse> {
  return jsonResponse({
    instances: registry.list(),
    total: registry.size,
  });
}
