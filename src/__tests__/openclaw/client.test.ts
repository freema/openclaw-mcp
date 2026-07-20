import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenClawClient } from '../../openclaw/client.js';
import { OpenClawApiError, OpenClawConnectionError } from '../../utils/errors.js';

describe('OpenClawClient', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: OpenClawClient;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = new OpenClawClient('https://openclaw.example.com', 'test-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockJsonResponse(data: unknown, status = 200, headers?: Record<string, string>) {
    const body = JSON.stringify(data);
    fetchSpy.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: {
        get: (name: string) => {
          if (headers && headers[name]) return headers[name];
          if (name === 'content-length') return String(body.length);
          return null;
        },
      },
      text: () => Promise.resolve(body),
    });
  }

  describe('constructor', () => {
    it('strips trailing slash from baseUrl', async () => {
      const c = new OpenClawClient('https://example.com/');
      mockJsonResponse({ status: 'ok' });
      await c.health();
      expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/v1/chat/completions');
    });
  });

  describe('health', () => {
    it('returns ok when gateway responds with 200', async () => {
      fetchSpy.mockResolvedValue({
        status: 200,
        statusText: 'OK',
      });

      const result = await client.health();
      expect(result.status).toBe('ok');
      expect(result.message).toContain('200');
    });

    it('returns ok when gateway responds with 400 (alive, rejected input)', async () => {
      fetchSpy.mockResolvedValue({
        status: 400,
        statusText: 'Bad Request',
      });

      const result = await client.health();
      expect(result.status).toBe('ok');
      expect(result.message).toContain('400');
    });

    it('returns error when gateway responds with 500', async () => {
      fetchSpy.mockResolvedValue({
        status: 500,
        statusText: 'Internal Server Error',
      });

      const result = await client.health();
      expect(result.status).toBe('error');
    });

    it('throws OpenClawConnectionError on network failure', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
      await expect(client.health()).rejects.toThrow(OpenClawConnectionError);
    });

    it('throws OpenClawConnectionError on timeout', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      fetchSpy.mockRejectedValue(abortError);

      const fastClient = new OpenClawClient('https://openclaw.example.com', undefined, 100);
      await expect(fastClient.health()).rejects.toThrow(OpenClawConnectionError);
      await expect(fastClient.health()).rejects.toThrow(/timed out/);
    });

    it('sends health check to /v1/chat/completions', async () => {
      fetchSpy.mockResolvedValue({ status: 200 });
      await client.health();
      expect(fetchSpy.mock.calls[0][0]).toBe('https://openclaw.example.com/v1/chat/completions');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('health-check');
      expect(body.max_tokens).toBe(1);
    });
  });

  describe('chat', () => {
    it('sends message via OpenAI-compatible endpoint and maps response', async () => {
      const openaiResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'claude-opus-4-5',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello from OpenClaw!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      mockJsonResponse(openaiResponse);

      const result = await client.chat('Hi');
      expect(result.response).toBe('Hello from OpenClaw!');
      expect(result.model).toBe('claude-opus-4-5');
      expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

      const callArgs = fetchSpy.mock.calls[0];
      expect(callArgs[0]).toBe('https://openclaw.example.com/v1/chat/completions');
      expect(callArgs[1].method).toBe('POST');

      const body = JSON.parse(callArgs[1].body);
      expect(body.model).toBe('openclaw');
      expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
      expect(body.max_tokens).toBe(4096);
    });

    it('uses custom model from constructor', async () => {
      const customClient = new OpenClawClient(
        'https://openclaw.example.com',
        'test-token',
        120_000,
        'openclaw/my-agent'
      );
      const openaiResponse = {
        id: 'chatcmpl-custom',
        object: 'chat.completion',
        created: 1234567890,
        model: 'openclaw/my-agent',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
      };
      mockJsonResponse(openaiResponse);

      await customClient.chat('Hi');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('openclaw/my-agent');
    });

    it('returns empty string when no choices in response', async () => {
      const openaiResponse = {
        id: 'chatcmpl-456',
        object: 'chat.completion',
        created: 1234567890,
        model: 'claude-opus-4-5',
        choices: [],
      };
      mockJsonResponse(openaiResponse);

      const result = await client.chat('Hi');
      expect(result.response).toBe('');
    });

    it('sends Authorization header when gateway token is set', async () => {
      const openaiResponse = {
        id: 'chatcmpl-789',
        object: 'chat.completion',
        created: 1234567890,
        model: 'claude-opus-4-5',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
      };
      mockJsonResponse(openaiResponse);

      await client.chat('test');
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer test-token');
    });

    it('does not send Authorization header when no token', async () => {
      const noTokenClient = new OpenClawClient('https://openclaw.example.com');
      const openaiResponse = {
        id: 'chatcmpl-000',
        object: 'chat.completion',
        created: 1234567890,
        model: 'claude-opus-4-5',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
      };
      mockJsonResponse(openaiResponse);

      await noTokenClient.chat('test');
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('throws OpenClawApiError on HTTP 500 for chat', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: () => null },
        text: () => Promise.resolve(''),
      });

      await expect(client.chat('test')).rejects.toThrow(OpenClawApiError);
      await expect(client.chat('test')).rejects.toThrow(/500/);
    });

    it('throws OpenClawConnectionError on network failure', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
      await expect(client.chat('test')).rejects.toThrow(OpenClawConnectionError);
    });

    it('throws OpenClawConnectionError on timeout (AbortError)', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      fetchSpy.mockRejectedValue(abortError);

      const fastClient = new OpenClawClient('https://openclaw.example.com', undefined, 100);
      await expect(fastClient.chat('test')).rejects.toThrow(OpenClawConnectionError);
      await expect(fastClient.chat('test')).rejects.toThrow(/timed out/);
    });

    it('rejects responses with Content-Length exceeding 10MB', async () => {
      const oversizeLength = String(11 * 1024 * 1024);
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => (name === 'content-length' ? oversizeLength : null),
        },
        text: () => Promise.resolve('{}'),
      });

      await expect(client.chat('test')).rejects.toThrow(OpenClawApiError);
      await expect(client.chat('test')).rejects.toThrow(/10MB/);
    });

    it('rejects responses with body exceeding 10MB', async () => {
      const largeBody = 'x'.repeat(10 * 1024 * 1024 + 1);
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: () => Promise.resolve(largeBody),
      });

      await expect(client.chat('test')).rejects.toThrow(OpenClawApiError);
      await expect(client.chat('test')).rejects.toThrow(/10MB/);
    });
  });

  describe('chat (streaming)', () => {
    function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
    }

    function mockStreamResponse(chunks: string[]) {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        body: sseStream(chunks),
      });
    }

    it('sets stream:true and accumulates deltas via onDelta', async () => {
      mockStreamResponse([
        'data: {"model":"openclaw","choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ]);

      const deltas: string[] = [];
      const result = await client.chat('hi', {
        onDelta: (delta) => deltas.push(delta),
      });

      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(requestBody.stream).toBe(true);
      expect(deltas).toEqual(['Hel', 'lo']);
      expect(result.response).toBe('Hello');
      expect(result.model).toBe('openclaw');
      expect(result.usage?.total_tokens).toBe(3);
    });

    it('handles SSE lines split across reads', async () => {
      mockStreamResponse([
        'data: {"choices":[{"delta":{"con',
        'tent":"AB"}}]}\ndata: {"choices":[{"delta":{"content":"C"}}]}\n',
        'data: [DONE]\n',
      ]);

      const result = await client.chat('hi', { onDelta: () => {} });
      expect(result.response).toBe('ABC');
    });

    it('skips unparseable SSE lines without failing', async () => {
      mockStreamResponse([
        'data: not-json\n',
        ': keepalive comment\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
        'data: [DONE]\n',
      ]);

      const result = await client.chat('hi', { onDelta: () => {} });
      expect(result.response).toBe('ok');
    });

    it('throws OpenClawApiError on non-2xx streaming response', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        headers: { get: () => null },
        body: null,
      });

      await expect(client.chat('hi', { onDelta: () => {} })).rejects.toThrow(OpenClawApiError);
    });

    it('completes when the stream ends without [DONE]', async () => {
      mockStreamResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n']);

      const result = await client.chat('hi', { onDelta: () => {} });
      expect(result.response).toBe('partial');
    });

    it('does not drop a final event that arrives without a trailing newline', async () => {
      mockStreamResponse([
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}',
      ]);

      const result = await client.chat('hi', { onDelta: () => {} });
      expect(result.response).toBe('Hello world');
    });

    it('captures the trailing usage chunk that follows finish_reason', async () => {
      mockStreamResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n',
        'data: [DONE]\n',
      ]);

      const result = await client.chat('hi', { onDelta: () => {} });
      expect(result.response).toBe('hi');
      expect(result.usage?.total_tokens).toBe(4);
    });

    it('stops at a terminal finish_reason without waiting for [DONE]', async () => {
      // A buffering proxy may hold the socket open after the answer is done;
      // finish_reason is the signal that nothing more is coming.
      mockStreamResponse([
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n',
      ]);

      const result = await client.chat('hi', { onDelta: () => {} });
      expect(result.response).toBe('done');
    });

    it('splits on lone CR terminators', async () => {
      mockStreamResponse(['data: {"choices":[{"delta":{"content":"AB"}}]}\rdata: [DONE]\r']);

      const result = await client.chat('hi', { onDelta: () => {} });
      expect(result.response).toBe('AB');
    });

    it('requests an SSE response', async () => {
      mockStreamResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\ndata: [DONE]\n']);

      await client.chat('hi', { onDelta: () => {} });
      const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Accept']).toBe('text/event-stream');
    });

    it('raises an error when the gateway reports a failure mid-stream', async () => {
      mockStreamResponse(['data: {"error":{"message":"upstream exploded"}}\n']);

      await expect(client.chat('hi', { onDelta: () => {} })).rejects.toThrow(/upstream exploded/);
    });

    it('raises an error instead of returning an empty success for a non-SSE body', async () => {
      // Gateway ignored stream:true and answered with plain JSON.
      mockStreamResponse(['{"choices":[{"message":{"content":"the real answer"}}]}']);

      await expect(client.chat('hi', { onDelta: () => {} })).rejects.toThrow(/no streamed content/);
    });

    it('reports a caller-initiated cancel as a cancellation, not a timeout', async () => {
      const controller = new AbortController();
      fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        });
      });

      const promise = client.chat('hi', { onDelta: () => {}, signal: controller.signal });
      controller.abort();
      await expect(promise).rejects.toThrow(/cancelled/i);
    });
  });
});
