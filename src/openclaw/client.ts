import { OpenClawConnectionError, OpenClawApiError } from '../utils/errors.js';
import { logDebug, isDebugEnabled } from '../utils/logger.js';
import type {
  OpenClawHealthResponse,
  OpenClawChatResponse,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChunk,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_DEBUG_BODY_LENGTH = 4096;

export interface ChatOptions {
  sessionId?: string;
  /** External cancellation (e.g. task cancel). Aborts the in-flight request. */
  signal?: AbortSignal;
  /**
   * Called with each streamed content delta. When set, the request uses
   * `stream: true` and the timeout becomes an idle timeout: it resets on every
   * received chunk, so long-running gateway work doesn't hit the absolute
   * timeout as long as the stream stays alive.
   */
  onDelta?: (delta: string, accumulated: string) => void;
}

export class OpenClawClient {
  private baseUrl: string;
  private gatewayToken: string | undefined;
  private timeoutMs: number;
  private model: string;

  constructor(
    baseUrl: string,
    gatewayToken?: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    model: string = 'openclaw'
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.gatewayToken = gatewayToken;
    this.timeoutMs = timeoutMs;
    this.model = model;
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

  private truncateForLog(value: string): string {
    if (value.length <= MAX_DEBUG_BODY_LENGTH) return value;
    return value.slice(0, MAX_DEBUG_BODY_LENGTH) + `... (truncated, ${value.length} chars total)`;
  }

  /**
   * Wire an external AbortSignal to the internal controller so both
   * timeout aborts and caller-initiated cancels stop the request.
   */
  private linkSignal(controller: AbortController, signal?: AbortSignal): () => void {
    if (!signal) return () => {};
    if (signal.aborted) {
      controller.abort(signal.reason);
      return () => {};
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  private toConnectionError(error: unknown): OpenClawConnectionError {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return new OpenClawConnectionError(`Request to OpenClaw timed out after ${this.timeoutMs}ms`);
    }
    return new OpenClawConnectionError(
      `Failed to connect to OpenClaw at ${this.baseUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    logDebug(() => `Request: ${options.method ?? 'GET'} ${url}`);
    if (options.body) {
      logDebug(() => `Request body: ${this.truncateForLog(options.body as string)}`);
    }

    const controller = new AbortController();
    const unlink = this.linkSignal(controller, options.signal ?? undefined);
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
        if (isDebugEnabled()) {
          const contentLength = response.headers.get('content-length');
          if (!contentLength || parseInt(contentLength, 10) <= MAX_RESPONSE_SIZE_BYTES) {
            const errorBody = await response.text();
            if (errorBody.length <= MAX_RESPONSE_SIZE_BYTES) {
              logDebug(
                () => `Response error (${response.status}): ${this.truncateForLog(errorBody)}`
              );
            }
          }
        }
        throw new OpenClawApiError(
          `API request failed: ${response.status} ${response.statusText}`,
          response.status
        );
      }

      logDebug(() => `Response: ${response.status} ${response.statusText}`);

      // Validate response size before consuming the body
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE_BYTES) {
        throw new OpenClawApiError('Response exceeds maximum allowed size (10MB)', 413);
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_SIZE_BYTES) {
        throw new OpenClawApiError('Response exceeds maximum allowed size (10MB)', 413);
      }

      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof OpenClawApiError) {
        throw error;
      }
      throw this.toConnectionError(error);
    } finally {
      clearTimeout(timeout);
      unlink();
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
      throw this.toConnectionError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Send a chat message via the OpenAI-compatible /v1/chat/completions endpoint.
   * With `options.onDelta` set, the request streams (SSE) and deltas are
   * surfaced as they arrive; otherwise a single blocking JSON response is used.
   */
  async chat(message: string, options: ChatOptions = {}): Promise<OpenClawChatResponse> {
    const { sessionId, signal, onDelta } = options;
    const streaming = onDelta !== undefined;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'user', content: message }],
      max_tokens: 4096,
    };
    if (streaming) {
      body.stream = true;
    }
    if (sessionId) {
      body.session_id = sessionId;
    }

    const headers: Record<string, string> = {};
    if (sessionId) {
      headers['x-openclaw-session-key'] = sessionId;
    }

    if (!streaming) {
      const completion = await this.request<OpenAIChatCompletionResponse>('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
        headers,
        signal: signal ?? null,
      });

      const content = completion.choices?.[0]?.message?.content ?? '';
      return {
        response: content,
        model: completion.model,
        usage: completion.usage,
      };
    }

    return this.chatStreaming(body, headers, signal, onDelta);
  }

  private async chatStreaming(
    body: Record<string, unknown>,
    extraHeaders: Record<string, string>,
    signal: AbortSignal | undefined,
    onDelta: (delta: string, accumulated: string) => void
  ): Promise<OpenClawChatResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    logDebug(() => `Request (stream): POST ${url}`);

    const controller = new AbortController();
    const unlink = this.linkSignal(controller, signal);
    // Idle timeout: reset on every received chunk, so slow-but-alive gateway
    // work is not killed while a silent/dead connection still aborts.
    let idleTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...this.buildHeaders(), ...extraHeaders },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new OpenClawApiError(
          `API request failed: ${response.status} ${response.statusText}`,
          response.status
        );
      }

      if (!response.body) {
        throw new OpenClawConnectionError('Streaming response has no body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let model: string | undefined;
      let usage: OpenClawChatResponse['usage'];
      let done = false;

      const reader = response.body.getReader();
      try {
        while (!done) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          resetIdle();

          buffer += decoder.decode(value, { stream: true });
          if (buffer.length + accumulated.length > MAX_RESPONSE_SIZE_BYTES) {
            throw new OpenClawApiError('Response exceeds maximum allowed size (10MB)', 413);
          }

          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              done = true;
              break;
            }

            let chunk: OpenAIChatCompletionChunk;
            try {
              chunk = JSON.parse(payload) as OpenAIChatCompletionChunk;
            } catch {
              logDebug(() => `Skipping unparseable SSE line: ${this.truncateForLog(payload)}`);
              continue;
            }

            if (chunk.model) model = chunk.model;
            if (chunk.usage) usage = chunk.usage;

            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              accumulated += delta;
              if (accumulated.length > MAX_RESPONSE_SIZE_BYTES) {
                throw new OpenClawApiError('Response exceeds maximum allowed size (10MB)', 413);
              }
              onDelta(delta, accumulated);
            }
          }
        }
      } finally {
        // Release the connection if we exited before the stream drained.
        await reader.cancel().catch(() => {});
      }

      logDebug(() => `Stream complete (${accumulated.length} chars)`);
      return { response: accumulated, model, usage };
    } catch (error) {
      if (error instanceof OpenClawApiError) {
        throw error;
      }
      throw this.toConnectionError(error);
    } finally {
      clearTimeout(idleTimer);
      unlink();
    }
  }
}
