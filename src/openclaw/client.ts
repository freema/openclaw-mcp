import { OpenClawConnectionError, OpenClawApiError } from '../utils/errors.js';
import type {
  OpenClawHealthResponse,
  OpenClawChatResponse,
  OpenAIChatCompletionResponse,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export class OpenClawClient {
  private baseUrl: string;
  private gatewayToken: string | undefined;
  private timeoutMs: number;

  constructor(baseUrl: string, gatewayToken?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.gatewayToken = gatewayToken;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Read a response body with a size limit, aborting early if the limit is exceeded.
   * This prevents a malicious server from consuming memory via chunked transfer encoding.
   */
  private async readBodyWithLimit(
    response: globalThis.Response,
    controller: AbortController
  ): Promise<string> {
    // Use streaming reader when available to abort early on oversized chunked responses
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let totalBytes = 0;
      const chunks: string[] = [];

      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (done) break;

        totalBytes += result.value.byteLength;
        if (totalBytes > MAX_RESPONSE_SIZE_BYTES) {
          controller.abort();
          throw new OpenClawApiError('Response exceeds maximum allowed size (10MB)', 413);
        }

        chunks.push(decoder.decode(result.value, { stream: true }));
      }
      // Flush the decoder
      chunks.push(decoder.decode());
      return chunks.join('');
    }

    // Fallback for environments where .body is not a ReadableStream
    const text = await response.text();
    if (text.length > MAX_RESPONSE_SIZE_BYTES) {
      throw new OpenClawApiError('Response exceeds maximum allowed size (10MB)', 413);
    }
    return text;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.gatewayToken) {
      headers['Authorization'] = `Bearer ${this.gatewayToken}`;
    }
    return headers;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...this.buildHeaders(),
          ...((options.headers as Record<string, string>) || {}),
        },
      });

      if (!response.ok) {
        throw new OpenClawApiError(
          `API request failed: ${response.status} ${response.statusText}`,
          response.status
        );
      }

      // Validate response size before consuming the body
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE_BYTES) {
        throw new OpenClawApiError('Response exceeds maximum allowed size (10MB)', 413);
      }

      // Stream the body incrementally to catch oversized chunked responses
      // before loading the entire payload into memory
      const text = await this.readBodyWithLimit(response, controller);

      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof OpenClawApiError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new OpenClawConnectionError(
          `Request to OpenClaw timed out after ${this.timeoutMs}ms`
        );
      }
      throw new OpenClawConnectionError(
        `Failed to connect to OpenClaw at ${this.baseUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Check gateway health by sending a minimal chat completion request.
   * A 400 Bad Request means the gateway is alive (it parsed JSON, rejected input).
   * A successful response also means healthy.
   * Connection errors mean the gateway is down.
   */
  async health(): Promise<OpenClawHealthResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: 'health-check',
          messages: [],
          max_tokens: 1,
        }),
      });

      // Both 200 and 400 mean the gateway is alive and processing requests
      if (response.status >= 200 && response.status < 500) {
        return { status: 'ok', message: `Gateway responding (HTTP ${response.status})` };
      }

      return { status: 'error', message: `Gateway error (HTTP ${response.status})` };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new OpenClawConnectionError(
          `Request to OpenClaw timed out after ${this.timeoutMs}ms`
        );
      }
      throw new OpenClawConnectionError(
        `Failed to connect to OpenClaw at ${this.baseUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Send a chat message via the OpenAI-compatible /v1/chat/completions endpoint.
   */
  async chat(message: string, sessionId?: string): Promise<OpenClawChatResponse> {
    const body: Record<string, unknown> = {
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: message }],
      max_tokens: 4096,
    };

    if (sessionId) {
      body.session_id = sessionId;
    }

    const headers: Record<string, string> = {};
    if (sessionId) {
      headers['x-openclaw-session-key'] = sessionId;
    }

    const completion = await this.request<OpenAIChatCompletionResponse>('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
    });

    const content = completion.choices?.[0]?.message?.content ?? '';

    return {
      response: content,
      model: completion.model,
      usage: completion.usage,
    };
  }
}
