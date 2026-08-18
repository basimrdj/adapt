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

  it('adjust-setTimeout slows only matching timers by 1/boost', () => {
    const original = globalThis.setTimeout;
    const calls: unknown[][] = [];
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        calls.push(args);
        return 0;
      },
    });
    try {
      expect(runMainScriptlet('adjust-setTimeout', ['snoop', '', '0.5'])).toBe(true);
      globalThis.setTimeout(function snoop() { /* noop */ }, 100);
      globalThis.setTimeout(function unrelated() { /* noop */ }, 100);
      expect(calls[0]?.[1]).toBe(200); // 100 * (1 / 0.5)
      expect(calls[1]?.[1]).toBe(100);
      expect(runMainScriptlet('adjust-setTimeout', ['x', '', '2'])).toBe(false); // boost out of range
    } finally {
      Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value: original });
    }
  });

  it('adjust-setInterval respects the optional delay pattern and default boost', () => {
    const original = globalThis.setInterval;
    const calls: unknown[][] = [];
    Object.defineProperty(globalThis, 'setInterval', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        calls.push(args);
        return 0;
      },
    });
    try {
      expect(runMainScriptlet('adjust-setInterval', ['ticker', '100', ''])).toBe(true);
      globalThis.setInterval(function ticker() { /* noop */ }, 100);
      globalThis.setInterval(function ticker() { /* noop */ }, 50);
      expect(calls[0]?.[1]).toBe(2000); // 100 * (1 / 0.05 default)
      expect(calls[1]?.[1]).toBe(50); // delay pattern did not match
      expect(runMainScriptlet('adjust-setInterval', [])).toBe(false); // handler pattern required
    } finally {
      Object.defineProperty(globalThis, 'setInterval', { configurable: true, writable: true, value: original });
    }
  });

  it('prevent-setInterval swallows only matching registrations', () => {
    const original = globalThis.setInterval;
    const calls: unknown[][] = [];
    Object.defineProperty(globalThis, 'setInterval', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        calls.push(args);
        return 7;
      },
    });
    try {
      expect(runMainScriptlet('prevent-setInterval', ['ticker'])).toBe(true);
      const swallowed = globalThis.setInterval(function ticker() { /* noop */ }, 100);
      const kept = globalThis.setInterval(function heartbeat() { /* noop */ }, 100);
      expect(swallowed).toBe(0); // blocked: no real timer registered
      expect(kept).toBe(7); // passthrough reached the (stubbed) native
      expect(calls).toHaveLength(1);
    } finally {
      Object.defineProperty(globalThis, 'setInterval', { configurable: true, writable: true, value: original });
    }
  });

  it('prevent-addEventListener suppresses only matching registrations', () => {
    const original = EventTarget.prototype.addEventListener;
    try {
      expect(runMainScriptlet('prevent-addEventListener', ['click', 'tracker'])).toBe(true);
      const target = new EventTarget();
      let trackerFired = 0;
      let benignFired = 0;
      target.addEventListener('click', function trackerHandler() {
        trackerFired += 1;
      });
      target.addEventListener('click', function benignHandler() {
        benignFired += 1;
      });
      target.addEventListener('scroll', function trackerHandler() {
        trackerFired += 1;
      });
      target.dispatchEvent(new Event('click'));
      target.dispatchEvent(new Event('scroll'));
      expect(trackerFired).toBe(1); // only the scroll registration survived
      expect(benignFired).toBe(1);
      expect(runMainScriptlet('prevent-addEventListener', ['', ''])).toBe(false);
    } finally {
      Object.defineProperty(EventTarget.prototype, 'addEventListener', { configurable: true, writable: true, value: original });
    }
  });

  it('set-cookie writes a path=/ cookie and rejects unsafe names', () => {
    const jar = { cookie: '' };
    (globalThis as Record<string, unknown>).document = jar;
    try {
      expect(runMainScriptlet('set-cookie', ['consent', 'yes'])).toBe(true);
      expect(jar.cookie).toBe('consent=yes; path=/');
      expect(runMainScriptlet('set-cookie', ['bad;name', 'x'])).toBe(false);
      expect(runMainScriptlet('set-cookie', ['consent', 'a b'])).toBe(false);
      expect(runMainScriptlet('set-cookie', ['only-name'])).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }
  });

  it('set-local-storage-item and set-session-storage-item store canonical strings', () => {
    const makeStorage = () => {
      const backing = new Map<string, string>();
      return {
        backing,
        setItem: (key: string, value: string) => void backing.set(key, value),
        getItem: (key: string) => backing.get(key) ?? null,
        removeItem: (key: string) => void backing.delete(key),
      };
    };
    const local = makeStorage();
    const session = makeStorage();
    (globalThis as Record<string, unknown>).localStorage = local;
    (globalThis as Record<string, unknown>).sessionStorage = session;
    try {
      expect(runMainScriptlet('set-local-storage-item', ['flag', 'false'])).toBe(true);
      expect(local.getItem('flag')).toBe('false');
      expect(runMainScriptlet('set-local-storage-item', 'cfg emptyObj'.split(' '))).toBe(true);
      expect(local.getItem('cfg')).toBe('{}');
      expect(runMainScriptlet('set-local-storage-item', ['flag', '$remove$'])).toBe(true);
      expect(local.getItem('flag')).toBeNull();
      expect(runMainScriptlet('set-local-storage-item', ['flag', 'noopFunc'])).toBe(false);
      expect(runMainScriptlet('set-local-storage-item', ['bad key', '1'])).toBe(false);
      expect(runMainScriptlet('set-session-storage-item', ['counter', '1'])).toBe(true);
      expect(session.getItem('counter')).toBe('1');
    } finally {
      delete (globalThis as Record<string, unknown>).localStorage;
      delete (globalThis as Record<string, unknown>).sessionStorage;
    }
  });

  it('prevent-element-src-loading aborts matching src assignments before any load', () => {
    class FakeImg {
      private inner = '';
      get src(): string {
        return this.inner;
      }
      set src(value: string) {
        this.inner = value;
      }
    }
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => (tag === 'img' ? new FakeImg() : new (class {})()),
    };
    try {
      expect(runMainScriptlet('prevent-element-src-loading', ['img', 'doubleclick'])).toBe(true);
      const img = (globalThis as unknown as { document: { createElement: (tag: string) => FakeImg } }).document.createElement('img');
      img.src = 'https://doubleclick.net/pixel.gif';
      expect(img.src).toBe(''); // aborted before the native setter
      img.src = 'https://cdn.example.com/photo.png';
      expect(img.src).toBe('https://cdn.example.com/photo.png');
      expect(runMainScriptlet('prevent-element-src-loading', ['div', '/x/'])).toBe(false);
      expect(runMainScriptlet('prevent-element-src-loading', ['img', ''])).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }
  });
});
