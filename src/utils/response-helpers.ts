// A `type` (not `interface`) so it gets an implicit index signature and stays
// assignable to the SDK's CallToolResult.
export type ToolResponse = {
  /** MCP 2026-07-28: every ordinary result declares itself 'complete'. */
  resultType: 'complete';
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function successResponse(text: string): ToolResponse {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text }],
  };
}

export function errorResponse(message: string): ToolResponse {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export function jsonResponse(data: unknown): ToolResponse {
  return successResponse(JSON.stringify(data, null, 2));
}
