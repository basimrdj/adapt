import { describe, expect, it } from 'vitest';
import { runMainScriptlet } from '../../src/shared/main-scriptlet';

describe('audited MAIN-world scriptlets', () => {
  it('supports bounded nested paths without prototype mutation', () => {
    const key = '__phase31b_constant__';
    expect(runMainScriptlet('set-constant', [`${key}.status`, 'false'])).toBe(true);
    expect(((globalThis as Record<string, unknown>)[key] as Record<string, unknown>).status).toBe(false);
    delete (globalThis as Record<string, unknown>)[key];
  });

  it('rejects prototype-pollution paths', () => {
    expect(runMainScriptlet('set-constant', ['__proto__.polluted', 'true'])).toBe(false);
    expect(runMainScriptlet('set-constant', ['Object.prototype.polluted', 'true'])).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('supports audited value modifiers', async () => {
    const functionKey = '__phase31b_function_constant__';
    const promiseKey = '__phase31b_promise_constant__';
    expect(runMainScriptlet('set-constant', [functionKey, 'true', 'asFunction'])).toBe(true);
    expect((globalThis as Record<string, unknown>)[functionKey]).toBeTypeOf('function');
    expect(runMainScriptlet('set-constant', [promiseKey, 'false', 'asResolved'])).toBe(true);
    await expect((globalThis as Record<string, unknown>)[promiseKey]).resolves.toBe(false);
    delete (globalThis as Record<string, unknown>)[functionKey];
    delete (globalThis as Record<string, unknown>)[promiseKey];
  });
});
