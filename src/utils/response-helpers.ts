// A `type` (not `interface`) so it gets an implicit index signature and stays
// assignable to the SDK's CallToolResult.
//
// `resultType` is deliberately NOT set here: the SDK treats it as a wire-only
// field and stamps it on the modern protocol itself. Setting it leaks the
// field onto the 2025-era wire, which current Claude clients speak.
export type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function successResponse(text: string): ToolResponse {
  return {
    content: [{ type: 'text', text }],
  };
}

export function errorResponse(message: string): ToolResponse {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export function jsonResponse(data: unknown): ToolResponse {
  return successResponse(JSON.stringify(data, null, 2));
}
