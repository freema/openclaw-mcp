import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../utils/rate-limit.js';

describe('RateLimiter', () => {
  it('allows requests within the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip1')).toBe(true);
  });

  it('blocks requests exceeding the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip1')).toBe(false);
  });

  it('tracks different keys independently', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip2')).toBe(true);
    expect(limiter.check('ip1')).toBe(false);
    expect(limiter.check('ip2')).toBe(false);
  });

  it('returns middleware function', () => {
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60_000 });
    const mw = limiter.middleware();
    expect(typeof mw).toBe('function');
  });

  it('middleware blocks when rate exceeded', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const mw = limiter.middleware();

    const req = { ip: '1.2.3.4', socket: { remoteAddress: '1.2.3.4' } } as any;
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };

    let statusCode: number | undefined;
    let jsonBody: unknown;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: (body: unknown) => (jsonBody = body) };
      },
    } as any;

    // First request should pass
    mw(req, res, next);
    expect(nextCalled).toBe(true);

    // Second request should be blocked
    nextCalled = false;
    mw(req, res, next);
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(429);
    expect(jsonBody).toEqual({ error: 'Too many requests. Try again later.' });
  });
});
