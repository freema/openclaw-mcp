/**
 * Simple in-memory sliding-window rate limiter.
 *
 * Tracks requests per IP address with automatic cleanup of stale entries.
 */

import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  timestamps: number[];
}

export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private config: RateLimitConfig;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config: RateLimitConfig) {
    this.config = config;
    // Cleanup stale entries every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Check if a request from this key should be allowed.
   * Returns true if within limits, false if rate-limited.
   */
  check(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let entry = this.entries.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.entries.set(key, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    if (entry.timestamps.length >= this.config.maxRequests) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /**
   * Express middleware factory.
   */
  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
      const key = req.ip || req.socket.remoteAddress || 'unknown';
      if (!this.check(key)) {
        res.status(429).json({ error: 'Too many requests. Try again later.' });
        return;
      }
      next();
    };
  }

  private cleanup(): void {
    const windowStart = Date.now() - this.config.windowMs;
    for (const [key, entry] of this.entries) {
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
      if (entry.timestamps.length === 0) {
        this.entries.delete(key);
      }
    }
  }
}
