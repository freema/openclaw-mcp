// Instance configuration for multi-instance support

export interface InstanceConfig {
  name: string;
  url: string;
  token?: string;
  timeout?: number;
  default?: boolean;
}

// OpenAI-compatible API types

export interface OpenAIChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// MCP-facing types (facade over OpenAI response)

export interface OpenClawChatResponse {
  response: string;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenClawHealthResponse {
  status: 'ok' | 'error';
  message?: string;
}
