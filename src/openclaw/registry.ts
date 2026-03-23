/**
 * Instance Registry for multi-instance OpenClaw support.
 *
 * Manages named OpenClawClient instances, each pointing to a different
 * OpenClaw gateway. Supports a default instance for backward compatibility.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { OpenClawClient } from './client.js';
import type { InstanceConfig } from './types.js';

const INSTANCE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * IPv4 private and reserved ranges (RFC 1918, loopback, link-local, etc.)
 * Each entry: [startLong, endLong]
 */
const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [ipv4ToLong('0.0.0.0'), ipv4ToLong('0.255.255.255')], // "This" network (RFC 1122)
  [ipv4ToLong('10.0.0.0'), ipv4ToLong('10.255.255.255')], // Private (RFC 1918)
  [ipv4ToLong('100.64.0.0'), ipv4ToLong('100.127.255.255')], // Shared address (RFC 6598)
  [ipv4ToLong('127.0.0.0'), ipv4ToLong('127.255.255.255')], // Loopback (RFC 1122)
  [ipv4ToLong('169.254.0.0'), ipv4ToLong('169.254.255.255')], // Link-local (RFC 3927)
  [ipv4ToLong('172.16.0.0'), ipv4ToLong('172.31.255.255')], // Private (RFC 1918)
  [ipv4ToLong('192.0.0.0'), ipv4ToLong('192.0.0.255')], // IETF protocol (RFC 6890)
  [ipv4ToLong('192.168.0.0'), ipv4ToLong('192.168.255.255')], // Private (RFC 1918)
  [ipv4ToLong('198.18.0.0'), ipv4ToLong('198.19.255.255')], // Benchmarking (RFC 2544)
  [ipv4ToLong('224.0.0.0'), ipv4ToLong('239.255.255.255')], // Multicast (RFC 5771)
  [ipv4ToLong('240.0.0.0'), ipv4ToLong('255.255.255.255')], // Reserved/broadcast
];

function ipv4ToLong(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const long = ipv4ToLong(ip);
  return PRIVATE_IPV4_RANGES.some(([start, end]) => long >= start && long <= end);
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true; // Loopback
  if (normalized === '::') return true; // Unspecified
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // Unique local (fc00::/7)
  if (normalized.startsWith('fe80')) return true; // Link-local (fe80::/10)
  if (normalized.startsWith('::ffff:')) {
    // IPv4-mapped IPv6
    const v4 = normalized.slice(7);
    if (isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  return false;
}

/**
 * Check if an IP address is in a private or reserved range.
 */
export function isPrivateIP(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  if (isIP(ip) === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Validate that a URL hostname does not resolve to a private/reserved IP.
 * Checks IP literals synchronously and resolves hostnames via DNS.
 */
export async function validateUrlNotPrivate(url: string, instanceName: string): Promise<void> {
  const parsed = new URL(url);
  let hostname = parsed.hostname;

  // Strip brackets from IPv6 literals (URL parser wraps them in brackets)
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  // Direct IP literal check
  if (isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      throw new Error(
        `Instance "${instanceName}": URL points to a private/reserved IP address (${hostname}). ` +
          'Private IP ranges are blocked to prevent SSRF attacks.'
      );
    }
    return;
  }

  // DNS resolution check for hostnames
  try {
    const result = await lookup(hostname, { all: true });
    const results = Array.isArray(result) ? result : [result];
    for (const entry of results) {
      if (isPrivateIP(entry.address)) {
        throw new Error(
          `Instance "${instanceName}": hostname "${hostname}" resolves to private/reserved IP (${entry.address}). ` +
            'Private IP ranges are blocked to prevent SSRF attacks.'
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Private IP ranges are blocked')) {
      throw error;
    }
    // DNS resolution failure at startup is a warning, not a hard block —
    // the hostname may not be resolvable from the build environment.
    // The URL scheme validation still applies.
  }
}

export class InstanceRegistry {
  private instances: Map<string, { config: InstanceConfig; client: OpenClawClient }> = new Map();
  private defaultName: string;

  constructor(configs: InstanceConfig[]) {
    if (configs.length === 0) {
      throw new Error('At least one OpenClaw instance must be configured');
    }

    const names = new Set<string>();
    let explicitDefault: string | undefined;

    for (const config of configs) {
      if (!INSTANCE_NAME_RE.test(config.name)) {
        throw new Error(
          `Invalid instance name "${config.name}": must be 1-64 chars, alphanumeric/dashes/underscores, start with alphanumeric`
        );
      }

      // Validate URL scheme (prevent SSRF)
      let parsed: URL;
      try {
        parsed = new URL(config.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error(
            `Instance "${config.name}": URL must use http or https (got ${parsed.protocol})`
          );
        }
      } catch (error) {
        if (error instanceof TypeError) {
          throw new Error(`Instance "${config.name}": invalid URL "${config.url}"`);
        }
        throw error;
      }

      // Block IP literals pointing to private/reserved ranges (synchronous check)
      let hostname = parsed.hostname;
      if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1);
      }
      if (isIP(hostname) && isPrivateIP(hostname)) {
        throw new Error(
          `Instance "${config.name}": URL points to a private/reserved IP address (${hostname}). ` +
            'Private IP ranges are blocked to prevent SSRF attacks.'
        );
      }

      if (names.has(config.name)) {
        throw new Error(`Duplicate instance name: "${config.name}"`);
      }
      names.add(config.name);

      if (config.default) {
        if (explicitDefault) {
          throw new Error(
            `Multiple default instances: "${explicitDefault}" and "${config.name}". Only one default is allowed.`
          );
        }
        explicitDefault = config.name;
      }

      const client = new OpenClawClient(config.url, config.token, config.timeout);
      this.instances.set(config.name, { config, client });
    }

    this.defaultName = explicitDefault ?? configs[0].name;
  }

  /**
   * Create an InstanceRegistry with full SSRF validation including DNS resolution.
   * Use this in production to catch hostnames that resolve to private IPs.
   */
  static async create(configs: InstanceConfig[]): Promise<InstanceRegistry> {
    const registry = new InstanceRegistry(configs);
    // Perform async DNS validation for non-IP hostnames
    for (const config of configs) {
      await validateUrlNotPrivate(config.url, config.name);
    }
    return registry;
  }

  /**
   * Get client by instance name. Returns undefined if not found.
   */
  get(name: string): OpenClawClient | undefined {
    return this.instances.get(name)?.client;
  }

  /**
   * Get the default client.
   */
  getDefault(): OpenClawClient {
    const entry = this.instances.get(this.defaultName);
    if (!entry) {
      throw new Error(`Default instance "${this.defaultName}" not found`);
    }
    return entry.client;
  }

  /**
   * Get the default instance name.
   */
  getDefaultName(): string {
    return this.defaultName;
  }

  /**
   * Resolve an optional instance name to a concrete client.
   * Falls back to default when name is undefined.
   */
  resolve(name?: string): { name: string; client: OpenClawClient } {
    if (!name) {
      return { name: this.defaultName, client: this.getDefault() };
    }
    const client = this.get(name);
    if (!client) {
      const available = this.listNames().join(', ');
      throw new Error(`Unknown instance "${name}". Available: ${available}`);
    }
    return { name, client };
  }

  /**
   * List instance names.
   */
  listNames(): string[] {
    return Array.from(this.instances.keys());
  }

  /**
   * List instances with safe metadata (never exposes tokens).
   */
  list(): Array<{ name: string; url: string; isDefault: boolean }> {
    return Array.from(this.instances.entries()).map(([name, { config }]) => ({
      name,
      url: config.url,
      isDefault: name === this.defaultName,
    }));
  }

  /**
   * Number of registered instances.
   */
  get size(): number {
    return this.instances.size;
  }

  /**
   * Check if this is a single-instance (backward-compat) setup.
   */
  get isSingleInstance(): boolean {
    return this.instances.size === 1;
  }
}
