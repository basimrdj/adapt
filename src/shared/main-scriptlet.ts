type PageObject = Record<string, unknown>;

const DANGEROUS_ROOTS = new Set([
  'Array', 'Atomics', 'BigInt', 'Boolean', 'Date', 'Document', 'Error', 'Function', 'JSON', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'Reflect', 'RegExp', 'String', 'Symbol', 'Window', 'chrome', 'document', 'globalThis', 'location', 'navigator', 'window',
]);

const STATE_KEY = '__adaptMainScriptletState__';

type ScriptletState = {
  wrappers: Set<string>;
};

function state(): ScriptletState {
  const root = globalThis as PageObject;
  const existing = root[STATE_KEY];
  if (existing && typeof existing === 'object' && 'wrappers' in existing) return existing as ScriptletState;
  const created: ScriptletState = { wrappers: new Set<string>() };
  Object.defineProperty(root, STATE_KEY, { configurable: true, enumerable: false, value: created });
  return created;
}

function safePath(value: string): string[] | null {
  const segments = value.split('.');
  if (segments.length === 0 || segments.length > 8) return null;
  if (!segments.every((segment) => /^[A-Za-z_$][\w$]{0,63}$/.test(segment))) return null;
  if (segments.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) return null;
  if (DANGEROUS_ROOTS.has(segments[0] ?? '')) return null;
  return segments;
}

function parentFor(path: string[], create: boolean): { parent: PageObject; key: string } | null {
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
}

function boundedRegex(value: string): RegExp | null {
  if (value.length > 500) return null;
  if (value.startsWith('/') && value.endsWith('/')) {
    try {
      return new RegExp(value.slice(1, -1), 'i');
    } catch {
      return null;
    }
  }
  return null;
}

function matches(value: unknown, pattern: string): boolean {
  const text = String(value ?? '');
  if (!pattern) return false;
  const alternatives = pattern.split('|').filter(Boolean);
  return alternatives.some((candidate) => {
    const regex = boundedRegex(candidate);
    if (regex) return regex.test(text);
    if (candidate.includes('*')) {
      const escaped = candidate.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return new RegExp(escaped, 'i').test(text);
    }
    return text.toLowerCase().includes(candidate.toLowerCase());
  });
}

function constantValue(valueName: string, modifiers: string[]): unknown {
  const base: Record<string, unknown> = {
    undefined,
    null: null,
    true: true,
    false: false,
    noopFunc: () => undefined,
    noopCallbackFunc: (..._args: unknown[]) => undefined,
    noopPromiseResolve: (..._args: unknown[]) => Promise.resolve(undefined),
    noopPromiseReject: (..._args: unknown[]) => Promise.reject(new Error('ADAPT rejected promise')),
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
}

function defineConstant(args: string[]): boolean {
  if (args.length < 2 || args.length > 5) return false;
  const path = safePath(args[0] ?? '');
  if (!path) return false;
  const valueName = args[1] ?? '';
  const value = constantValue(valueName, args.slice(2).filter(Boolean));
  if (value === undefined && valueName !== 'undefined') return false;
  const target = parentFor(path, true);
  if (!target) return false;
  try {
    Object.defineProperty(target.parent, target.key, { configurable: true, enumerable: false, get: () => value, set: () => undefined });
    return true;
  } catch {
    return false;
  }
}

function defineAbort(args: string[], write: boolean): boolean {
  const path = safePath(args[0] || '');
  if (!path) return false;
  const target = parentFor(path, true);
  if (!target) return false;
  const current = target.parent[target.key];
  try {
    Object.defineProperty(target.parent, target.key, write ? { configurable: true, enumerable: false, get: () => current, set: () => undefined } : { configurable: true, enumerable: false, get: () => { throw new Error('ADAPT scriptlet abort'); }, set: () => undefined });
    return true;
  } catch {
    return false;
  }
}

function preventFetch(args: string[]): boolean {
  const key = `prevent-fetch:${JSON.stringify(args)}`;
  const root = globalThis as PageObject;
  const original = root.fetch;
  if (typeof original !== 'function' || state().wrappers.has(key)) return false;
  const pattern = args[0] || '';
  const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (matches(url, pattern) || (args[1] && matches(init?.method, args[1]))) return Promise.reject(new Error('ADAPT blocked fetch'));
    return (original as (this: unknown, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>).call(this, input, init);
  };
  try {
    Object.defineProperty(root, 'fetch', { configurable: true, writable: true, value: wrapped });
    state().wrappers.add(key);
    return true;
  } catch {
    return false;
  }
}

interface AdaptXhr extends XMLHttpRequest {
  __adaptBlocked?: boolean;
  __adaptUrl?: string;
  __adaptMethod?: string;
}

function preventXhr(args: string[]): boolean {
  const key = `prevent-xhr:${JSON.stringify(args)}`;
  if (state().wrappers.has(key) || typeof XMLHttpRequest === 'undefined') return false;
  const prototype = XMLHttpRequest.prototype as AdaptXhr;
  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  prototype.open = function (this: AdaptXhr, method: string, url: string | URL, ...rest: unknown[]) {
    this.__adaptMethod = method;
    this.__adaptUrl = String(url);
    this.__adaptBlocked = matches(this.__adaptUrl ?? '', args[0] ?? '') || Boolean(args[1] && matches(method, args[1] ?? ''));
    return originalOpen.call(this, method, url, ...(rest as [boolean, string, string]));
  } as typeof prototype.open;
  prototype.send = function (this: AdaptXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    if (this.__adaptBlocked) {
      try { this.abort(); } catch { return; }
      return;
    }
    return originalSend.call(this, body);
  } as typeof prototype.send;
  state().wrappers.add(key);
  return true;
}

function preventSetTimeout(args: string[]): boolean {
  const key = `prevent-setTimeout:${JSON.stringify(args)}`;
  const root = globalThis as PageObject;
  const original = root.setTimeout;
  if (typeof original !== 'function' || state().wrappers.has(key)) return false;
  const wrapped = function (handler: TimerHandler, timeout?: number, ...rest: unknown[]): number {
    if (matches(typeof handler === 'function' ? handler.toString() : handler, args[0] || '')) return 0;
    return (original as (...values: unknown[]) => number)(handler, timeout, ...rest);
  };
  Object.defineProperty(root, 'setTimeout', { configurable: true, writable: true, value: wrapped });
  state().wrappers.add(key);
  return true;
}

function preventEvalIf(args: string[]): boolean {
  const key = `prevent-eval-if:${JSON.stringify(args)}`;
  const root = globalThis as PageObject;
  const original = root.eval;
  if (typeof original !== 'function' || state().wrappers.has(key)) return false;
  const wrapped = function (this: unknown, source: string): unknown {
    if (matches(source, args[0] ?? '')) return undefined;
    return (original as (source: string) => unknown).call(this, source);
  };
  Object.defineProperty(root, 'eval', { configurable: true, writable: true, value: wrapped });
  state().wrappers.add(key);
  return true;
}

function preventWindowOpen(args: string[]): boolean {
  const key = `prevent-window-open:${JSON.stringify(args)}`;
  if (state().wrappers.has(key) || typeof window.open !== 'function') return false;
  const original = window.open;
  window.open = function (url?: string | URL, target?: string, features?: string): Window | null {
    const text = `${String(url || '')} ${target || ''} ${features || ''}`;
    if (!args[0] || matches(text, args[0])) return null;
    return original.call(window, url, target, features);
  };
  state().wrappers.add(key);
  return true;
}

function prunePaths(value: unknown, paths: string[]): void {
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
}

function jsonPrune(args: string[]): boolean {
  const key = `json-prune:${JSON.stringify(args)}`;
  if (state().wrappers.has(key)) return false;
  const original = JSON.parse;
  JSON.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown {
    const value = original.call(JSON, text, reviver);
    prunePaths(value, args);
    return value;
  };
  state().wrappers.add(key);
  return true;
}

export function runMainScriptlet(name: string, args: string[]): boolean {
  if (name === 'set-constant') return defineConstant(args);
  if (name === 'abort-on-property-read') return defineAbort(args, false);
  if (name === 'abort-on-property-write') return defineAbort(args, true);
  if (name === 'abort-current-inline-script') return defineAbort(args, false);
  if (name === 'prevent-fetch') return preventFetch(args);
  if (name === 'prevent-xhr') return preventXhr(args);
  if (name === 'prevent-setTimeout') return preventSetTimeout(args);
  if (name === 'prevent-eval-if') return preventEvalIf(args);
  if (name === 'prevent-window-open') return preventWindowOpen(args);
  if (name === 'json-prune') return jsonPrune(args);
  return false;
}
