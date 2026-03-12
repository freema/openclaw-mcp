import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { createRateLimiter } from '../../middleware/rate-limiter.js';

function createMockReq(ip = '127.0.0.1'): Request {
  return {
    ip,
    headers: {},
    path: '/',
  } as unknown as Request;
}

function createMockRes(): Response & {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
} {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  };
}

describe('createRateLimiter', () => {
  let limiter: ReturnType<typeof createRateLimiter>;

  afterEach(() => {
    if (limiter) {
      limiter.dispose();
    }
  });

  it('allows requests under the limit', () => {
    limiter = createRateLimiter({ maxRequests: 5, windowMs: 60_000 });
    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    for (let i = 0; i < 5; i++) {
      limiter.middleware(req, res, next);
    }

    expect(next).toHaveBeenCalledTimes(5);
    expect(res.statusCode).toBe(200);
  });

  it('rejects requests over the limit with 429', () => {
    limiter = createRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    const req = createMockReq();
    const next = vi.fn();

    // First 3 pass
    for (let i = 0; i < 3; i++) {
      const res = createMockRes();
      limiter.middleware(req, res, next);
    }
    expect(next).toHaveBeenCalledTimes(3);

    // 4th is rejected
    const res = createMockRes();
    limiter.middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual(expect.objectContaining({ error: 'Too Many Requests' }));
  });

  it('sets Retry-After header on 429 responses', () => {
    limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const req = createMockReq();
    const next = vi.fn();

    // First passes
    limiter.middleware(req, createMockRes(), next);

    // Second is rejected
    const res = createMockRes();
    limiter.middleware(req, res, next);

    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
    const retryAfter = parseInt(res.headers['Retry-After'], 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('tracks different IPs separately', () => {
    limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const next = vi.fn();

    const req1 = createMockReq('10.0.0.1');
    const req2 = createMockReq('10.0.0.2');

    // Both clients get their own quota
    for (let i = 0; i < 2; i++) {
      limiter.middleware(req1, createMockRes(), next);
      limiter.middleware(req2, createMockRes(), next);
    }
    expect(next).toHaveBeenCalledTimes(4);

    // IP 1 is blocked but IP 2 still has no more quota either
    const res1 = createMockRes();
    limiter.middleware(req1, res1, next);
    expect(res1.statusCode).toBe(429);

    const res2 = createMockRes();
    limiter.middleware(req2, res2, next);
    expect(res2.statusCode).toBe(429);
  });

  it('resets after window expires', () => {
    vi.useFakeTimers();
    limiter = createRateLimiter({ maxRequests: 2, windowMs: 10_000 });
    const req = createMockReq();
    const next = vi.fn();

    // Exhaust limit
    limiter.middleware(req, createMockRes(), next);
    limiter.middleware(req, createMockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);

    // Blocked
    const blockedRes = createMockRes();
    limiter.middleware(req, blockedRes, next);
    expect(blockedRes.statusCode).toBe(429);

    // Advance past window
    vi.advanceTimersByTime(10_001);

    // Now allowed again
    const res = createMockRes();
    limiter.middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(res.statusCode).toBe(200);

    vi.useRealTimers();
  });

  it('supports custom key function', () => {
    limiter = createRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      keyFn: (req) => (req.headers['x-api-key'] as string) || 'anonymous',
    });
    const next = vi.fn();

    const req1 = {
      ip: '127.0.0.1',
      headers: { 'x-api-key': 'key-a' },
      path: '/',
    } as unknown as Request;
    const req2 = {
      ip: '127.0.0.1',
      headers: { 'x-api-key': 'key-b' },
      path: '/',
    } as unknown as Request;

    // Both pass (different keys despite same IP)
    limiter.middleware(req1, createMockRes(), next);
    limiter.middleware(req2, createMockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);

    // key-a is now blocked
    const res = createMockRes();
    limiter.middleware(req1, res, next);
    expect(res.statusCode).toBe(429);
  });

  it('dispose clears state and stops cleanup', () => {
    limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const req = createMockReq();
    const next = vi.fn();

    // Use up limit
    limiter.middleware(req, createMockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);

    // Dispose and create new one
    limiter.dispose();
    limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });

    // New limiter has fresh state
    const res = createMockRes();
    limiter.middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
  });

  it('uses x-forwarded-for as fallback when ip is undefined', () => {
    limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const next = vi.fn();

    const req = {
      ip: undefined,
      headers: { 'x-forwarded-for': '203.0.113.1' },
      path: '/',
    } as unknown as Request;

    limiter.middleware(req, createMockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);

    const res = createMockRes();
    limiter.middleware(req, res, next);
    expect(res.statusCode).toBe(429);
  });
});
