(() => {
  const dangerousRoots = new Set(['Array', 'Function', 'Object', 'Promise', 'Proxy', 'Reflect', 'Window', 'chrome', 'document', 'globalThis', 'location', 'navigator', 'window']);
  const stateKey = '__adaptEarlyScriptletState__';

  const safePath = (value) => {
    const segments = String(value || '').split('.');
    if (segments.length === 0 || segments.length > 8) return null;
    if (!segments.every((segment) => /^[A-Za-z_$][\w$]{0,63}$/.test(segment))) return null;
    if (segments.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) return null;
    if (dangerousRoots.has(segments[0])) return null;
    return segments;
  };

  const parentFor = (path) => {
    let current = globalThis;
    for (const segment of path.slice(0, -1)) {
      if (current[segment] && typeof current[segment] === 'object') {
        current = current[segment];
      } else {
        const next = Object.create(null);
        Object.defineProperty(current, segment, { configurable: true, enumerable: true, writable: true, value: next });
        current = next;
      }
    }
    return { parent: current, key: path[path.length - 1] };
  };

  const values = {
    undefined,
    null: null,
    true: true,
    false: false,
    noopFunc: () => undefined,
    noopCallbackFunc: () => undefined,
    noopPromiseResolve: () => Promise.resolve(undefined),
    noopPromiseReject: () => Promise.reject(new Error('ADAPT rejected promise')),
    trueFunc: () => true,
    falseFunc: () => false,
    emptyObj: Object.freeze(Object.create(null)),
    emptyArray: Object.freeze([]),
    emptyArr: Object.freeze([]),
  };

  const valueFor = (name, modifiers) => {
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : /^-?\d{1,6}(?:\.\d{1,3})?$/.test(name) ? Number(name) : name === '' ? '' : undefined;
    if (value === undefined && name !== 'undefined') return undefined;
    if (modifiers.includes('asFunction')) return () => value;
    if (modifiers.includes('asResolved')) return Promise.resolve(value);
    return value;
  };

  const apply = (rule) => {
    if (!rule || rule.name !== 'set-constant' || !Array.isArray(rule.args)) return false;
    const path = safePath(rule.args[0]);
    if (!path || rule.args.length < 2 || rule.args.length > 5) return false;
    const value = valueFor(rule.args[1], rule.args.slice(2).filter(Boolean));
    if (value === undefined && rule.args[1] !== 'undefined') return false;
    try {
      const target = parentFor(path);
      Object.defineProperty(target.parent, target.key, { configurable: true, enumerable: false, get: () => value, set: () => undefined });
      return true;
    } catch {
      return false;
    }
  };

  Object.defineProperty(globalThis, stateKey, { configurable: false, enumerable: false, writable: false, value: Object.freeze({ apply }) });
})();
