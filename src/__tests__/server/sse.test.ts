import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadCorsConfig, isOriginAllowed, parseTrustProxy } from '../../server/sse.js';

describe('loadCorsConfig', () => {
  beforeEach(() => {
    vi.stubEnv('CORS_ORIGINS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns wildcard when env is undefined', () => {
    delete process.env.CORS_ORIGINS;
    const config = loadCorsConfig();
    expect(config.origins).toEqual(['*']);
    expect(config.enabled).toBe(true);
  });

  it('returns wildcard for "*"', () => {
    vi.stubEnv('CORS_ORIGINS', '*');
    const config = loadCorsConfig();
    expect(config.origins).toEqual(['*']);
    expect(config.enabled).toBe(true);
  });

  it('disables CORS for "none"', () => {
    vi.stubEnv('CORS_ORIGINS', 'none');
    const config = loadCorsConfig();
    expect(config.origins).toEqual([]);
    expect(config.enabled).toBe(false);
  });

  it('parses comma-separated origins', () => {
    vi.stubEnv('CORS_ORIGINS', 'https://a.com, https://b.com');
    const config = loadCorsConfig();
    expect(config.origins).toEqual(['https://a.com', 'https://b.com']);
    expect(config.enabled).toBe(true);
  });
});

describe('isOriginAllowed', () => {
  it('returns false for undefined origin', () => {
    expect(isOriginAllowed(undefined, ['*'])).toBe(false);
  });

  it('allows any origin with wildcard', () => {
    expect(isOriginAllowed('https://example.com', ['*'])).toBe(true);
  });

  it('matches exact origin', () => {
    expect(isOriginAllowed('https://example.com', ['https://example.com'])).toBe(true);
    expect(isOriginAllowed('https://other.com', ['https://example.com'])).toBe(false);
  });

  it('matches wildcard subdomain pattern', () => {
    expect(isOriginAllowed('https://sub.example.com', ['*.example.com'])).toBe(true);
    expect(isOriginAllowed('https://deep.sub.example.com', ['*.example.com'])).toBe(true);
  });

  it('matches exact domain for wildcard pattern', () => {
    expect(isOriginAllowed('https://example.com', ['*.example.com'])).toBe(true);
  });

  it('rejects subdomain bypass via domain suffix', () => {
    expect(isOriginAllowed('https://evil.comexample.com', ['*.example.com'])).toBe(false);
    expect(isOriginAllowed('https://notexample.com', ['*.example.com'])).toBe(false);
  });

  it('rejects invalid origins for wildcard pattern', () => {
    expect(isOriginAllowed('not-a-url', ['*.example.com'])).toBe(false);
  });

  it('matches with protocol prefix', () => {
    expect(isOriginAllowed('https://example.com', ['example.com'])).toBe(true);
    expect(isOriginAllowed('http://example.com', ['example.com'])).toBe(true);
  });
});

describe('parseTrustProxy', () => {
  it('returns undefined for unset input', () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseTrustProxy('')).toBeUndefined();
    expect(parseTrustProxy('   ')).toBeUndefined();
  });

  it('parses "true" / "false" (case-insensitive) into booleans', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('False')).toBe(false);
  });

  it('parses pure-digit strings into numbers (hop count)', () => {
    expect(parseTrustProxy('0')).toBe(0);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('passes CIDR / IP / keyword strings through untouched', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('linklocal')).toBe('linklocal');
    expect(parseTrustProxy('uniquelocal')).toBe('uniquelocal');
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(parseTrustProxy('192.168.1.1')).toBe('192.168.1.1');
  });

  it('trims surrounding whitespace', () => {
    expect(parseTrustProxy('  1  ')).toBe(1);
    expect(parseTrustProxy('  true  ')).toBe(true);
  });
});
