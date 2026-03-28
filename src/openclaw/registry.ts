/**
 * Instance Registry for multi-instance OpenClaw support.
 *
 * Manages named OpenClawClient instances, each pointing to a different
 * OpenClaw gateway. Supports a default instance for backward compatibility.
 */

import { OpenClawClient } from './client.js';
import type { InstanceConfig } from './types.js';

const INSTANCE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class InstanceRegistry {
  private instances: Map<string, { config: InstanceConfig; client: OpenClawClient }> = new Map();
  private defaultName: string;

  constructor(configs: InstanceConfig[], model?: string) {
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
      try {
        const parsed = new URL(config.url);
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

      const client = new OpenClawClient(config.url, config.token, config.timeout, model);
      this.instances.set(config.name, { config, client });
    }

    this.defaultName = explicitDefault ?? configs[0].name;
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
