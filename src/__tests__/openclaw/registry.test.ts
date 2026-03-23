import { describe, it, expect } from 'vitest';
import { InstanceRegistry, isPrivateIP, validateUrlNotPrivate } from '../../openclaw/registry.js';

describe('InstanceRegistry', () => {
  const configs = [
    { name: 'prod', url: 'http://prod:18789', token: 'tok1', default: true },
    { name: 'staging', url: 'http://staging:18789', token: 'tok2' },
    { name: 'dev', url: 'http://dev:18789' },
  ];

  it('creates registry from valid configs', () => {
    const registry = new InstanceRegistry(configs);
    expect(registry.size).toBe(3);
  });

  it('resolves default instance', () => {
    const registry = new InstanceRegistry(configs);
    const resolved = registry.resolve();
    expect(resolved.name).toBe('prod');
  });

  it('resolves named instance', () => {
    const registry = new InstanceRegistry(configs);
    const resolved = registry.resolve('staging');
    expect(resolved.name).toBe('staging');
  });

  it('throws on unknown instance name', () => {
    const registry = new InstanceRegistry(configs);
    expect(() => registry.resolve('nonexistent')).toThrow('Unknown instance "nonexistent"');
  });

  it('uses first instance as default when none marked', () => {
    const registry = new InstanceRegistry([
      { name: 'a', url: 'http://a:1' },
      { name: 'b', url: 'http://b:1' },
    ]);
    expect(registry.getDefaultName()).toBe('a');
  });

  it('throws on empty configs', () => {
    expect(() => new InstanceRegistry([])).toThrow('At least one');
  });

  it('throws on duplicate names', () => {
    expect(
      () =>
        new InstanceRegistry([
          { name: 'dup', url: 'http://a:1' },
          { name: 'dup', url: 'http://b:1' },
        ])
    ).toThrow('Duplicate instance name');
  });

  it('throws on multiple defaults', () => {
    expect(
      () =>
        new InstanceRegistry([
          { name: 'a', url: 'http://a:1', default: true },
          { name: 'b', url: 'http://b:1', default: true },
        ])
    ).toThrow('Multiple default instances');
  });

  it('throws on invalid name', () => {
    expect(() => new InstanceRegistry([{ name: '-bad', url: 'http://a:1' }])).toThrow(
      'Invalid instance name'
    );
  });

  it('lists instances without exposing tokens', () => {
    const registry = new InstanceRegistry(configs);
    const list = registry.list();
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({ name: 'prod', url: 'http://prod:18789', isDefault: true });
    expect(list[1]).toEqual({ name: 'staging', url: 'http://staging:18789', isDefault: false });
    // Ensure no token field
    for (const item of list) {
      expect(item).not.toHaveProperty('token');
    }
  });

  it('isSingleInstance returns true for one instance', () => {
    const registry = new InstanceRegistry([{ name: 'default', url: 'http://localhost:18789' }]);
    expect(registry.isSingleInstance).toBe(true);
  });

  it('isSingleInstance returns false for multiple', () => {
    const registry = new InstanceRegistry(configs);
    expect(registry.isSingleInstance).toBe(false);
  });

  it('rejects non-http URL schemes', () => {
    expect(() => new InstanceRegistry([{ name: 'bad', url: 'file:///etc/passwd' }])).toThrow(
      'must use http or https'
    );
    expect(() => new InstanceRegistry([{ name: 'bad', url: 'ftp://evil.com' }])).toThrow(
      'must use http or https'
    );
  });

  it('accepts http and https URLs', () => {
    const registry = new InstanceRegistry([
      { name: 'http', url: 'http://localhost:18789' },
      { name: 'https', url: 'https://prod.example.com' },
    ]);
    expect(registry.size).toBe(2);
  });

  it('rejects invalid URLs', () => {
    expect(() => new InstanceRegistry([{ name: 'bad', url: 'not-a-url' }])).toThrow('invalid URL');
  });

  describe('SSRF private IP validation', () => {
    it('rejects RFC 1918 10.x.x.x addresses', () => {
      expect(() => new InstanceRegistry([{ name: 'bad', url: 'http://10.0.0.1:18789' }])).toThrow(
        'private/reserved IP address'
      );
      expect(
        () => new InstanceRegistry([{ name: 'bad', url: 'http://10.255.255.255:18789' }])
      ).toThrow('private/reserved IP address');
    });

    it('rejects RFC 1918 172.16.x.x addresses', () => {
      expect(() => new InstanceRegistry([{ name: 'bad', url: 'http://172.16.0.1:18789' }])).toThrow(
        'private/reserved IP address'
      );
      expect(
        () => new InstanceRegistry([{ name: 'bad', url: 'http://172.31.255.255:18789' }])
      ).toThrow('private/reserved IP address');
    });

    it('allows non-private 172.x addresses', () => {
      // 172.15.x.x and 172.32.x.x are public
      const registry = new InstanceRegistry([
        { name: 'a', url: 'http://172.15.0.1:18789' },
        { name: 'b', url: 'http://172.32.0.1:18789' },
      ]);
      expect(registry.size).toBe(2);
    });

    it('rejects RFC 1918 192.168.x.x addresses', () => {
      expect(
        () => new InstanceRegistry([{ name: 'bad', url: 'http://192.168.0.1:18789' }])
      ).toThrow('private/reserved IP address');
      expect(
        () => new InstanceRegistry([{ name: 'bad', url: 'http://192.168.255.255:18789' }])
      ).toThrow('private/reserved IP address');
    });

    it('rejects loopback addresses', () => {
      expect(() => new InstanceRegistry([{ name: 'bad', url: 'http://127.0.0.1:18789' }])).toThrow(
        'private/reserved IP address'
      );
      expect(
        () => new InstanceRegistry([{ name: 'bad', url: 'http://127.255.255.255:18789' }])
      ).toThrow('private/reserved IP address');
    });

    it('rejects link-local addresses (169.254.x.x)', () => {
      expect(
        () => new InstanceRegistry([{ name: 'bad', url: 'http://169.254.169.254:80' }])
      ).toThrow('private/reserved IP address');
    });

    it('rejects 0.0.0.0', () => {
      expect(() => new InstanceRegistry([{ name: 'bad', url: 'http://0.0.0.0:18789' }])).toThrow(
        'private/reserved IP address'
      );
    });

    it('rejects IPv6 loopback (::1)', () => {
      expect(() => new InstanceRegistry([{ name: 'bad', url: 'http://[::1]:18789' }])).toThrow(
        'private/reserved IP address'
      );
    });

    it('rejects IPv6 unique local (fc00::/fd00::)', () => {
      expect(() => new InstanceRegistry([{ name: 'bad', url: 'http://[fc00::1]:18789' }])).toThrow(
        'private/reserved IP address'
      );
      expect(() => new InstanceRegistry([{ name: 'bad', url: 'http://[fd12::1]:18789' }])).toThrow(
        'private/reserved IP address'
      );
    });

    it('rejects IPv6 link-local (fe80::)', () => {
      expect(() => new InstanceRegistry([{ name: 'bad', url: 'http://[fe80::1]:18789' }])).toThrow(
        'private/reserved IP address'
      );
    });

    it('allows public IP addresses', () => {
      const registry = new InstanceRegistry([
        { name: 'pub1', url: 'http://8.8.8.8:18789' },
        { name: 'pub2', url: 'http://203.0.113.1:18789' },
      ]);
      expect(registry.size).toBe(2);
    });

    it('allows hostname-based URLs in constructor (DNS check is async)', () => {
      // Hostnames are allowed in the synchronous constructor; DNS validation
      // happens in the async InstanceRegistry.create() factory method
      const registry = new InstanceRegistry([{ name: 'a', url: 'http://prod.example.com:18789' }]);
      expect(registry.size).toBe(1);
    });
  });
});

describe('isPrivateIP', () => {
  it('identifies private IPv4 addresses', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('192.168.1.1')).toBe(true);
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('169.254.169.254')).toBe(true);
    expect(isPrivateIP('0.0.0.0')).toBe(true);
  });

  it('identifies public IPv4 addresses', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('1.1.1.1')).toBe(false);
    expect(isPrivateIP('203.0.113.1')).toBe(false);
  });

  it('identifies private IPv6 addresses', () => {
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('::')).toBe(true);
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fd12:3456::1')).toBe(true);
    expect(isPrivateIP('fe80::1')).toBe(true);
  });

  it('returns false for non-IP strings', () => {
    expect(isPrivateIP('not-an-ip')).toBe(false);
    expect(isPrivateIP('example.com')).toBe(false);
  });
});

describe('validateUrlNotPrivate', () => {
  it('rejects URLs with private IP literals', async () => {
    await expect(validateUrlNotPrivate('http://10.0.0.1:18789', 'test')).rejects.toThrow(
      'private/reserved IP address'
    );
    await expect(validateUrlNotPrivate('http://[::1]:18789', 'test')).rejects.toThrow(
      'private/reserved IP address'
    );
  });

  it('allows URLs with public IP literals', async () => {
    await expect(validateUrlNotPrivate('http://8.8.8.8:18789', 'test')).resolves.toBeUndefined();
  });
});
