import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('logger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  async function loadLogger() {
    return await import('../../utils/logger.js');
  }

  describe('log', () => {
    it('logs with [openclaw-mcp] prefix', async () => {
      const { log } = await loadLogger();
      log('hello world');
      expect(consoleSpy).toHaveBeenCalledWith('[openclaw-mcp] hello world');
    });
  });

  describe('logError', () => {
    it('logs with ERROR prefix', async () => {
      const { logError } = await loadLogger();
      logError('something failed');
      expect(consoleSpy).toHaveBeenCalledWith('[openclaw-mcp] ERROR: something failed');
    });

    it('logs Error instance message', async () => {
      const { logError } = await loadLogger();
      logError('oops', new Error('details'));
      expect(consoleSpy).toHaveBeenCalledWith('[openclaw-mcp] ERROR: oops');
      expect(consoleSpy).toHaveBeenCalledWith('[openclaw-mcp] details');
    });

    it('logs non-Error objects generically', async () => {
      const { logError } = await loadLogger();
      logError('oops', 'string-error');
      expect(consoleSpy).toHaveBeenCalledWith('[openclaw-mcp] (non-Error object thrown)');
    });
  });

  describe('logDebug', () => {
    it('does not log when debug is disabled (default)', async () => {
      const { logDebug } = await loadLogger();
      logDebug('should not appear');
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('logs with DEBUG prefix when enabled', async () => {
      const { logDebug, setDebugEnabled } = await loadLogger();
      setDebugEnabled(true);
      logDebug('test message');
      expect(consoleSpy).toHaveBeenCalledWith('[openclaw-mcp] DEBUG: test message');
      setDebugEnabled(false);
    });

    it('sanitizes sensitive data in debug messages', async () => {
      const { logDebug, setDebugEnabled } = await loadLogger();
      setDebugEnabled(true);
      logDebug('Auth: Bearer eyJhbGciOiJIUzI1NiJ9.secret');
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      setDebugEnabled(false);
    });

    it('accepts a callback and only calls it when debug is enabled', async () => {
      const { logDebug, setDebugEnabled } = await loadLogger();
      const factory = vi.fn(() => 'lazy message');

      logDebug(factory);
      expect(factory).not.toHaveBeenCalled();
      expect(consoleSpy).not.toHaveBeenCalled();

      setDebugEnabled(true);
      logDebug(factory);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith('[openclaw-mcp] DEBUG: lazy message');
      setDebugEnabled(false);
    });
  });

  describe('setDebugEnabled / isDebugEnabled', () => {
    it('can toggle debug on and off', async () => {
      const { logDebug, setDebugEnabled } = await loadLogger();

      setDebugEnabled(true);
      logDebug('visible');
      expect(consoleSpy).toHaveBeenCalledTimes(1);

      consoleSpy.mockClear();
      setDebugEnabled(false);
      logDebug('invisible');
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('isDebugEnabled returns current state', async () => {
      const { isDebugEnabled, setDebugEnabled } = await loadLogger();

      expect(isDebugEnabled()).toBe(false);
      setDebugEnabled(true);
      expect(isDebugEnabled()).toBe(true);
      setDebugEnabled(false);
      expect(isDebugEnabled()).toBe(false);
    });
  });

  describe('sanitization', () => {
    it('redacts Bearer tokens', async () => {
      const { log } = await loadLogger();
      log('Auth: Bearer eyJhbGciOiJIUzI1NiJ9.test');
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('redacts API keys', async () => {
      const { log } = await loadLogger();
      log('api_key=abcdefghij1234567890');
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('abcdefghij1234567890');
    });

    it('redacts secrets', async () => {
      const { log } = await loadLogger();
      log('secret=mysupersecretvalue123');
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('mysupersecretvalue123');
    });
  });
});
