import { afterEach, describe, expect, it } from 'vitest';
import { parseArguments } from '../cli.js';

describe('parseArguments', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('keeps the last value of a repeated --transport flag', () => {
    // The Docker ENTRYPOINT already passes `--transport http`; a user adding it
    // again must not turn transport into an array and fall back to stdio.
    process.argv = ['node', 'openclaw-mcp', '--transport', 'http', '--transport', 'http'];
    expect(parseArguments('0.0.0-test').transport).toBe('http');
  });

  it('uses the later value when --transport is given twice with different values', () => {
    process.argv = ['node', 'openclaw-mcp', '--transport', 'http', '--transport', 'stdio'];
    expect(parseArguments('0.0.0-test').transport).toBe('stdio');
  });
});
