type PageObject = Record<string, unknown>;

export function runMainScriptlet(name: string, args: string[]): boolean {
  const dangerousRoots = new Set([
    'Array', 'Atomics', 'BigInt', 'Boolean', 'Date', 'Document', 'Error', 'Function', 'JSON', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'Reflect', 'RegExp', 'String', 'Symbol', 'Uint8Array', 'Window', 'chrome', 'document', 'globalThis', 'location', 'navigator', 'window',
  ]);
  const wrappers = new Set<string>();

  const safePath = (value: string): string[] | null => {
    const segments = value.split('.');
    if (segments.length === 0 || segments.length > 8) return null;
    if (!segments.every((segment) => /^[A-Za-z_$][\w$]{0,63}$/.test(segment))) return null;
    if (segments.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) return null;
    if (dangerousRoots.has(segments[0] ?? '')) return null;
    return segments;
  };

  const parentFor = (path: string[], create: boolean): { parent: PageObject; key: string } | null => {
    let current = globalThis as PageObject;
    for (const segment of path.slice(0, -1)) {
      const value = current[segment];
      if (value && typeof value === 'object') {
        current = value as PageObject;
        continue;
      }
      if (!create) return null;
      const next: PageObject = Object.create(null) as PageObject;
      try {
        Object.defineProperty(current, segment, { configurable: true, enumerable: true, writable: true, value: next });
        current = next;
      } catch {
        return null;
      }
    }
    const key = path[path.length - 1];
    return key ? { parent: current, key } : null;
  };

  const boundedRegex = (value: string): RegExp | null => {
    if (value.length > 500 || !value.startsWith('/') || !value.endsWith('/')) return null;
    try {
      return new RegExp(value.slice(1, -1), 'i');
    } catch {
      return null;
    }
  };

  const matches = (value: unknown, pattern: string): boolean => {
    const text = String(value ?? '');
    if (!pattern) return false;
    return pattern.split('|').filter(Boolean).some((candidate) => {
      const regex = boundedRegex(candidate);
      if (regex) return regex.test(text);
      if (candidate.includes('*')) {
        const escaped = candidate.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        return new RegExp(escaped, 'i').test(text);
      }
      return text.toLowerCase().includes(candidate.toLowerCase());
    });
  };

  const constantValue = (valueName: string, modifiers: string[]): unknown => {
    const base: Record<string, unknown> = {
      undefined,
      null: null,
      true: true,
      false: false,
      noopFunc: () => undefined,
      noopCallbackFunc: (..._args: unknown[]) => undefined,
      noopPromiseResolve: (..._args: unknown[]) => Promise.resolve(undefined),
      noopPromiseReject: (..._args: unknown[]) => Promise.reject(new Error()),
      trueFunc: () => true,
      falseFunc: () => false,
      emptyObj: Object.freeze(Object.create(null)),
      emptyArray: Object.freeze([]),
      emptyArr: Object.freeze([]),
    };
    const parsed = Object.prototype.hasOwnProperty.call(base, valueName) ? base[valueName] : /^-?\d{1,6}(?:\.\d{1,3})?$/.test(valueName) ? Number(valueName) : valueName === '' ? '' : undefined;
    if (parsed === undefined && valueName !== 'undefined') return undefined;
    if (modifiers.includes('asFunction')) return () => parsed;
    if (modifiers.includes('asResolved')) return Promise.resolve(parsed);
    return parsed;
  };

  const defineConstant = (values: string[]): boolean => {
    if (values.length < 2 || values.length > 5) return false;
    const path = safePath(values[0] ?? '');
    if (!path) return false;
    const valueName = values[1] ?? '';
    const value = constantValue(valueName, values.slice(2).filter(Boolean));
    if (value === undefined && valueName !== 'undefined') return false;
    const target = parentFor(path, true);
    if (!target) return false;
    try {
      Object.defineProperty(target.parent, target.key, { configurable: true, enumerable: false, get: () => value, set: () => undefined });
      return true;
    } catch {
      return false;
    }
  };

  const defineAbort = (values: string[], write: boolean): boolean => {
    const path = safePath(values[0] || '');
    if (!path) return false;
    const target = parentFor(path, true);
    if (!target) return false;
    const current = target.parent[target.key];
    try {
      Object.defineProperty(target.parent, target.key, write
        ? { configurable: true, enumerable: false, get: () => current, set: () => undefined }
        : { configurable: true, enumerable: false, get: () => { throw new TypeError(); }, set: () => undefined });
      return true;
    } catch {
      return false;
    }
  };

  const abortCurrentInlineScript = (values: string[]): boolean => {
    const path = safePath(values[0] || '');
    if (!path) return false;
    const target = parentFor(path, true);
    if (!target) return false;
    const current = target.parent[target.key];
    const sourcePattern = values[1] || '';
    try {
      Object.defineProperty(target.parent, target.key, {
        configurable: true,
        enumerable: false,
        get: () => {
          const source = typeof document === 'undefined' ? '' : document.currentScript?.textContent || '';
          if (!sourcePattern || matches(source, sourcePattern)) throw new TypeError();
          return current;
        },
        set: () => undefined,
      });
      return true;
    } catch {
      return false;
    }
  };

  const preventFetch = (values: string[]): boolean => {
    const key = `fetch:${JSON.stringify(values)}`;
    const root = globalThis as PageObject;
    const original = root.fetch;
    if (typeof original !== 'function' || wrappers.has(key)) return false;
    const pattern = values[0] || '';
    const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (matches(url, pattern) || (values[1] && matches(init?.method, values[1]))) return Promise.reject(new Error());
      return (original as (this: unknown, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>).call(this, input, init);
    };
    try {
      Object.defineProperty(root, 'fetch', { configurable: true, writable: true, value: wrapped });
      wrappers.add(key);
      return true;
    } catch {
      return false;
    }
  };

  const preventXhr = (values: string[]): boolean => {
    const key = `xhr:${JSON.stringify(values)}`;
    if (wrappers.has(key) || typeof XMLHttpRequest === 'undefined') return false;
    const blocked = new WeakMap<XMLHttpRequest, boolean>();
    const prototype = XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      blocked.set(this, matches(String(url), values[0] || '') || Boolean(values[1] && matches(method, values[1])));
      return originalOpen.call(this, method, url, ...(rest as [boolean, string, string]));
    } as typeof prototype.open;
    prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      if (blocked.get(this)) {
        try { this.abort(); } catch { return; }
        return;
      }
      return originalSend.call(this, body);
    } as typeof prototype.send;
    wrappers.add(key);
    return true;
  };

  const preventSetTimeout = (values: string[]): boolean => {
    const key = `timeout:${JSON.stringify(values)}`;
    const root = globalThis as PageObject;
    const original = root.setTimeout;
    if (typeof original !== 'function' || wrappers.has(key)) return false;
    const wrapped = function (handler: TimerHandler, timeout?: number, ...rest: unknown[]): number {
      if (matches(typeof handler === 'function' ? handler.toString() : handler, values[0] || '')) return 0;
      return (original as (...args: unknown[]) => number)(handler, timeout, ...rest);
    };
    Object.defineProperty(root, 'setTimeout', { configurable: true, writable: true, value: wrapped });
    wrappers.add(key);
    return true;
  };

  const preventEvalIf = (values: string[]): boolean => {
    const key = `eval:${JSON.stringify(values)}`;
    const root = globalThis as PageObject;
    const original = root.eval;
    if (typeof original !== 'function' || wrappers.has(key)) return false;
    const wrapped = function (this: unknown, source: string): unknown {
      if (matches(source, values[0] ?? '')) return undefined;
      return (original as (source: string) => unknown).call(this, source);
    };
    Object.defineProperty(root, 'eval', { configurable: true, writable: true, value: wrapped });
    wrappers.add(key);
    return true;
  };

  const preventWindowOpen = (values: string[]): boolean => {
    const key = `open:${JSON.stringify(values)}`;
    if (wrappers.has(key) || typeof window.open !== 'function') return false;
    const original = window.open;
    window.open = function (url?: string | URL, target?: string, features?: string): Window | null {
      const text = `${String(url || '')} ${target || ''} ${features || ''}`;
      if (!values[0] || matches(text, values[0])) return null;
      return original.call(window, url, target, features);
    };
    wrappers.add(key);
    return true;
  };

  const prunePaths = (value: unknown, paths: string[]): void => {
    if (!value || typeof value !== 'object') return;
    for (const path of paths.flatMap((entry) => entry.split('|')).filter(Boolean)) {
      const segments = path.split('.').filter(Boolean);
      if (segments.length === 0 || segments.some((segment) => !/^[A-Za-z_$][\w$]*$/.test(segment) && segment !== '*')) continue;
      const walk = (current: unknown, index: number): void => {
        if (!current || typeof current !== 'object') return;
        const key = segments[index];
        if (!key) return;
        if (key === '*') {
          for (const child of Object.keys(current as object)) walk((current as PageObject)[child], index + 1);
          return;
        }
        if (index === segments.length - 1) {
          delete (current as PageObject)[key];
          return;
        }
        walk((current as PageObject)[key], index + 1);
      };
      walk(value, 0);
    }
  };

  const jsonPrune = (values: string[]): boolean => {
    const key = `json:${JSON.stringify(values)}`;
    if (wrappers.has(key)) return false;
    const original = JSON.parse;
    JSON.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown {
      const value = original.call(JSON, text, reviver);
      prunePaths(value, values);
      return value;
    };
    wrappers.add(key);
    return true;
  };

  if (name === 'set-constant') return defineConstant(args);
  if (name === 'abort-on-property-read') return defineAbort(args, false);
  if (name === 'abort-on-property-write') return defineAbort(args, true);
  if (name === 'abort-current-inline-script') return abortCurrentInlineScript(args);
  if (name === 'prevent-fetch') return preventFetch(args);
  if (name === 'prevent-xhr') return preventXhr(args);
  if (name === 'prevent-setTimeout') return preventSetTimeout(args);
  if (name === 'prevent-eval-if') return preventEvalIf(args);
  if (name === 'prevent-window-open') return preventWindowOpen(args);
  if (name === 'json-prune') return jsonPrune(args);
  return false;
}
