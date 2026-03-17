import { describe, it, expect } from 'vitest';
import { InstanceRegistry } from '../../openclaw/registry.js';

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

  it('backward-compatible single instance from default env var pattern', () => {
    const registry = new InstanceRegistry([
      { name: 'default', url: 'http://127.0.0.1:18789', token: 'tok', default: true },
    ]);
    expect(registry.size).toBe(1);
    expect(registry.getDefaultName()).toBe('default');
    const resolved = registry.resolve();
    expect(resolved.name).toBe('default');
  });
});
