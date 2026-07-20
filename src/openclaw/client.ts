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
/**
 * Hard ceiling on a streamed request. The idle timeout alone is not enough:
 * a gateway that emits heartbeats forever would otherwise hold a task slot
 * for the lifetime of the process.
 */
const DEFAULT_MAX_STREAM_MS = 30 * 60 * 1000; // 30 minutes

/**
 * How long to keep reading after a terminal `finish_reason`, waiting for the
 * trailing chunk that carries token usage.
 */
const FINISH_GRACE_MS = 2_000;

/** Why the internal controller aborted, so a cancel isn't reported as a timeout. */
type AbortCause = 'idle' | 'max-duration' | 'finish-grace';

export interface ChatOptions {
  sessionId?: string;
  /** External cancellation (e.g. task cancel). Aborts the in-flight request. */
  signal?: AbortSignal;
  /**
   * Called with each streamed content delta. When set, the request uses
   * `stream: true` and the timeout becomes an idle timeout: it resets on every
   * received chunk, so long-running gateway work doesn't hit the timeout as
   * long as the stream stays alive. A separate absolute cap still applies.
   */
  onDelta?: (delta: string, accumulated: string) => void;
}

/** Raised when the caller's own AbortSignal stopped the request. */
export class OpenClawCancelledError extends Error {
  constructor(message = 'Request was cancelled') {
    super(message);
    this.name = 'OpenClawCancelledError';
  }
}

export class OpenClawClient {
  private baseUrl: string;
  private gatewayToken: string | undefined;
  private timeoutMs: number;
  private model: string;
  private maxStreamMs: number;

  constructor(
    baseUrl: string,
    gatewayToken?: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    model: string = 'openclaw',
    maxStreamMs: number = DEFAULT_MAX_STREAM_MS
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.gatewayToken = gatewayToken;
    this.timeoutMs = timeoutMs;
    this.model = model;
    this.maxStreamMs = Math.max(maxStreamMs, timeoutMs);
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

  /**
   * Classify an aborted request. The caller's signal wins: only when the
   * external signal is the one that fired do we report a cancellation —
   * otherwise the abort came from our own timers.
   */
  private toConnectionError(error: unknown, cause?: AbortCause, callerSignal?: AbortSignal): Error {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (callerSignal?.aborted && cause === undefined) {
        return new OpenClawCancelledError();
      }
      if (cause === 'max-duration') {
        return new OpenClawConnectionError(
          `Request to OpenClaw exceeded the maximum duration of ${this.maxStreamMs}ms`
        );
      }
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
    let abortCause: AbortCause | undefined;
    const timeout = setTimeout(() => {
      abortCause = 'idle';
      controller.abort();
    }, this.timeoutMs);

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
      throw this.toConnectionError(error, abortCause, options.signal ?? undefined);
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
    let abortCause: AbortCause | undefined;
    const timeout = setTimeout(() => {
      abortCause = 'idle';
      controller.abort();
    }, this.timeoutMs);

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
      throw this.toConnectionError(error, abortCause);
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
    if (streaming) {
      // Without this a strict gateway may answer with a plain JSON body,
      // which the SSE reader would decode as an empty response.
      headers['Accept'] = 'text/event-stream';
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
    let abortCause: AbortCause | undefined;
    // Idle timeout: reset on every received chunk, so slow-but-alive gateway
    // work is not killed while a silent/dead connection still aborts.
    let idleTimer = setTimeout(() => {
      abortCause = 'idle';
      controller.abort();
    }, this.timeoutMs);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortCause = 'idle';
        controller.abort();
      }, this.timeoutMs);
    };
    // Absolute cap: heartbeats alone must not keep a task slot forever.
    const maxTimer = setTimeout(() => {
      abortCause = 'max-duration';
      controller.abort();
    }, this.maxStreamMs);
    /**
     * After finish_reason the answer is complete; wait only briefly for the
     * trailing usage chunk rather than the full idle timeout.
     */
    const startFinishGrace = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortCause = 'finish-grace';
        controller.abort();
      }, FINISH_GRACE_MS);
    };

    // Hoisted so the catch can still return a completed answer if the grace
    // window below expires before the trailing chunk arrives.
    let accumulated = '';
    let model: string | undefined;
    let usage: OpenClawChatResponse['usage'];
    let finishReason: string | null | undefined;

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
      let receivedBytes = 0;
      let done = false;

      /** Handle one SSE line. Returns true when the stream is terminated. */
      const handleLine = (rawLine: string): boolean => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return false;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return true;

        let chunk: OpenAIChatCompletionChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIChatCompletionChunk;
        } catch {
          logDebug(() => `Skipping unparseable SSE line: ${this.truncateForLog(payload)}`);
          return false;
        }

        // Gateways can report a failure mid-stream after a 200 response.
        if (chunk.error) {
          throw new OpenClawApiError(
            `Gateway reported an error: ${chunk.error.message ?? 'unknown error'}`,
            502
          );
        }

        if (chunk.model) model = chunk.model;
        if (chunk.usage) {
          usage = chunk.usage;
          // usage rides in a trailing chunk after finish_reason; once we have
          // both there is nothing left worth waiting for.
          if (finishReason) return true;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          accumulated += delta;
          onDelta(delta, accumulated);
        }

        // A terminal finish_reason means the answer itself is complete. Don't
        // wait out the full idle timeout for [DONE] (a buffering proxy may
        // never send it) — but do allow a short grace window for the trailing
        // usage chunk, which arrives after finish_reason.
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
          if (usage) return true;
          startFinishGrace();
        }
        return false;
      };

      /** Split on LF or CR (both are valid SSE terminators). */
      const nextBreak = (s: string): number => {
        const lf = s.indexOf('\n');
        const cr = s.indexOf('\r');
        if (lf === -1) return cr;
        if (cr === -1) return lf;
        return Math.min(lf, cr);
      };

      const reader = response.body.getReader();
      try {
        while (!done) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          resetIdle();

          receivedBytes += value.byteLength;
          if (receivedBytes > MAX_RESPONSE_SIZE_BYTES) {
            throw new OpenClawApiError('Response exceeds maximum allowed size (10MB)', 413);
          }

          buffer += decoder.decode(value, { stream: true });

          let breakIndex;
          while ((breakIndex = nextBreak(buffer)) !== -1) {
            const line = buffer.slice(0, breakIndex);
            buffer = buffer.slice(breakIndex + 1);
            if (handleLine(line)) {
              done = true;
              break;
            }
          }
        }

        // Flush the decoder and parse a trailing line that arrived without a
        // terminator — otherwise the last event would be silently dropped.
        if (!done) {
          buffer += decoder.decode();
          if (buffer.trim()) {
            handleLine(buffer);
          }
        }
      } finally {
        // Release the connection if we exited before the stream drained.
        await reader.cancel().catch(() => {});
      }

      if (!accumulated && !finishReason) {
        // No content and no terminal marker: the body was not a usable SSE
        // stream. Reporting an empty success here would silently hand the
        // caller a blank answer.
        throw new OpenClawApiError(
          'Gateway returned no streamed content (not a valid SSE response)',
          502
        );
      }

      logDebug(() => `Stream complete (${accumulated.length} chars, finish=${finishReason})`);
      return { response: accumulated, model, usage };
    } catch (error) {
      if (error instanceof OpenClawApiError) {
        throw error;
      }
      // The grace window expiring is not a failure: the answer was already
      // complete, only the optional trailing usage chunk never arrived.
      if (abortCause === 'finish-grace' && finishReason) {
        logDebug(() => `Stream complete without trailing usage (${accumulated.length} chars)`);
        return { response: accumulated, model, usage };
      }
      throw this.toConnectionError(error, abortCause, signal);
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      unlink();
    }
  }
}
