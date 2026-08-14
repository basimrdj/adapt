(() => {
  const groups = Object.freeze(__EARLY_RULES__);
  const dangerousRoots = new Set(['Array', 'Atomics', 'BigInt', 'Boolean', 'Date', 'Document', 'Error', 'Function', 'JSON', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'Reflect', 'RegExp', 'String', 'Symbol', 'Uint8Array', 'Window', 'chrome', 'document', 'globalThis', 'location', 'navigator', 'window']);
  const wrappers = new Set();

  const safePath = (value) => {
    const segments = String(value || '').split('.');
    if (segments.length === 0 || segments.length > 8) return null;
    if (!segments.every((segment) => /^[A-Za-z_$][\w$]{0,63}$/.test(segment))) return null;
    if (segments.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) return null;
    if (dangerousRoots.has(segments[0] || '')) return null;
    return segments;
  };

  const parentFor = (path) => {
    let current = globalThis;
    for (const segment of path.slice(0, -1)) {
      const value = current[segment];
      if (value && typeof value === 'object') {
        current = value;
        continue;
      }
      const next = Object.create(null);
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

  const boundedRegex = (value) => {
    if (value.length > 500 || !value.startsWith('/') || !value.endsWith('/')) return null;
    try {
      return new RegExp(value.slice(1, -1), 'i');
    } catch {
      return null;
    }
  };

  const matches = (value, pattern) => {
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

  const constantValue = (name, modifiers) => {
    const values = {
      undefined,
      null: null,
      true: true,
      false: false,
      noopFunc: () => undefined,
      noopCallbackFunc: () => undefined,
      noopPromiseResolve: () => Promise.resolve(undefined),
      noopPromiseReject: () => Promise.reject(new Error()),
      trueFunc: () => true,
      falseFunc: () => false,
      emptyObj: Object.freeze(Object.create(null)),
      emptyArray: Object.freeze([]),
      emptyArr: Object.freeze([]),
    };
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : /^-?\d{1,6}(?:\.\d{1,3})?$/.test(name) ? Number(name) : name === '' ? '' : undefined;
    if (value === undefined && name !== 'undefined') return undefined;
    if (modifiers.includes('asFunction')) return () => value;
    if (modifiers.includes('asResolved')) return Promise.resolve(value);
    return value;
  };

  const setConstant = (args) => {
    if (args.length < 2 || args.length > 5) return false;
    const path = safePath(args[0]);
    if (!path) return false;
    const value = constantValue(args[1] || '', args.slice(2).filter(Boolean));
    if (value === undefined && args[1] !== 'undefined') return false;
    const target = parentFor(path);
    if (!target) return false;
    try {
      Object.defineProperty(target.parent, target.key, { configurable: true, enumerable: false, get: () => value, set: () => undefined });
      return true;
    } catch {
      return false;
    }
  };

  const abortOnRead = (args, write) => {
    const path = safePath(args[0] || '');
    if (!path) return false;
    const target = parentFor(path);
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

  const abortCurrentInlineScript = (args) => {
    const path = safePath(args[0] || '');
    if (!path) return false;
    const target = parentFor(path);
    if (!target) return false;
    const current = target.parent[target.key];
    const sourcePattern = args[1] || '';
    try {
      Object.defineProperty(target.parent, target.key, {
        configurable: true,
        enumerable: false,
        get: () => {
          const source = document.currentScript?.textContent || '';
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

  const preventSetTimeout = (args) => {
    const key = JSON.stringify(args);
    const original = globalThis.setTimeout;
    if (typeof original !== 'function' || wrappers.has(key)) return false;
    globalThis.setTimeout = function (handler, timeout, ...rest) {
      if (matches(typeof handler === 'function' ? handler.toString() : handler, args[0] || '')) return 0;
      return original(handler, timeout, ...rest);
    };
    wrappers.add(key);
    return true;
  };

  const preventEvalIf = (args) => {
    const key = JSON.stringify(args);
    const original = globalThis.eval;
    if (typeof original !== 'function' || wrappers.has(key)) return false;
    globalThis.eval = function (source) {
      if (matches(source, args[0] || '')) return undefined;
      return original.call(this, source);
    };
    wrappers.add(key);
    return true;
  };

  const prunePaths = (value, paths) => {
    if (!value || typeof value !== 'object') return;
    for (const path of paths.flatMap((entry) => entry.split('|')).filter(Boolean)) {
      const segments = path.split('.').filter(Boolean);
      if (segments.length === 0 || segments.some((segment) => !/^[A-Za-z_$][\w$]*$/.test(segment) && segment !== '*')) continue;
      const walk = (current, index) => {
        if (!current || typeof current !== 'object') return;
        const key = segments[index];
        if (!key) return;
        if (key === '*') {
          for (const child of Object.keys(current)) walk(current[child], index + 1);
          return;
        }
        if (index === segments.length - 1) {
          delete current[key];
          return;
        }
        walk(current[key], index + 1);
      };
      walk(value, 0);
    }
  };

  const jsonPrune = (args) => {
    const key = JSON.stringify(args);
    if (wrappers.has(key)) return false;
    const original = JSON.parse;
    JSON.parse = function (text, reviver) {
      const value = original.call(JSON, text, reviver);
      prunePaths(value, args);
      return value;
    };
    wrappers.add(key);
    return true;
  };

  const apply = (name, args) => {
    if (name === 'set-constant') return setConstant(args);
    if (name === 'abort-on-property-read') return abortOnRead(args, false);
    if (name === 'abort-on-property-write') return abortOnRead(args, true);
    if (name === 'abort-current-inline-script') return abortCurrentInlineScript(args);
    if (name === 'prevent-setTimeout') return preventSetTimeout(args);
    if (name === 'prevent-eval-if') return preventEvalIf(args);
    if (name === 'json-prune') return jsonPrune(args);
    return false;
  };

  const host = location.hostname.toLowerCase();
  for (const [domain, rules] of Object.entries(groups)) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      for (const rule of rules) apply(rule.name, rule.args);
    }
  }
})();
