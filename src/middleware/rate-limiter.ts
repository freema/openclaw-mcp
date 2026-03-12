/**
 * Sliding window rate limiter middleware for Express.
 *
 * Tracks request counts per client (by IP) within a configurable
 * time window. Returns HTTP 429 with Retry-After header when
 * the limit is exceeded.
 */

import type { Request, Response, NextFunction } from 'express';
import { log } from '../utils/logger.js';

export interface RateLimiterConfig {
  /** Time window in milliseconds (default: 60_000 = 1 minute) */
  windowMs: number;
  /** Maximum requests allowed per window (default: 60) */
  maxRequests: number;
  /** Custom function to extract the rate-limit key from a request */
  keyFn?: (req: Request) => string;
}

interface WindowEntry {
  count: number;
  windowStart: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 60;
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

/**
 * Extract the client key from a request.
 * Uses req.ip (which respects trust proxy settings) with
 * x-forwarded-for as fallback.
 */
function defaultKeyFn(req: Request): string {
  return req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown';
}

export interface RateLimiter {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  dispose: () => void;
}

/**
 * Create a rate limiter middleware instance.
 */
export function createRateLimiter(config?: Partial<RateLimiterConfig>): RateLimiter {
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRequests = config?.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const keyFn = config?.keyFn ?? defaultKeyFn;

  const clients = new Map<string, WindowEntry>();

  // Periodic cleanup of expired entries
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of clients) {
      if (now - entry.windowStart >= windowMs) {
        clients.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Allow the process to exit even if the timer is still running
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();
    const entry = clients.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      // New window
      clients.set(key, { count: 1, windowStart: now });
      next();
      return;
    }

    entry.count++;

    if (entry.count > maxRequests) {
      const retryAfterSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      log(`Rate limit exceeded for ${key} (${entry.count}/${maxRequests})`);
      res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: retryAfterSec,
      });
      return;
    }

    next();
  };

  const dispose = (): void => {
    clearInterval(cleanupTimer);
    clients.clear();
  };

  return { middleware, dispose };
}
