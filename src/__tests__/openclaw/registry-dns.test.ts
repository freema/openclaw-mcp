import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLookup } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: mockLookup,
}));

// Import after mock is set up
import { validateUrlNotPrivate } from '../../openclaw/registry.js';

describe('validateUrlNotPrivate (DNS resolution)', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it('rejects hostnames resolving to private IPs', async () => {
    mockLookup.mockResolvedValue([{ address: '192.168.1.1', family: 4 }]);

    await expect(validateUrlNotPrivate('http://evil.example.com:18789', 'test')).rejects.toThrow(
      'resolves to private/reserved IP'
    );
  });

  it('allows hostnames resolving to public IPs', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await expect(
      validateUrlNotPrivate('http://example.com:18789', 'test')
    ).resolves.toBeUndefined();
  });

  it('rejects if any resolved address is private', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);

    await expect(validateUrlNotPrivate('http://dual.example.com:18789', 'test')).rejects.toThrow(
      'resolves to private/reserved IP'
    );
  });

  it('does not throw when DNS resolution fails', async () => {
    mockLookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(
      validateUrlNotPrivate('http://internal.corp:18789', 'test')
    ).resolves.toBeUndefined();
  });

  it('rejects hostname resolving to link-local (cloud metadata)', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(validateUrlNotPrivate('http://metadata.internal:80', 'test')).rejects.toThrow(
      'resolves to private/reserved IP'
    );
  });
});
