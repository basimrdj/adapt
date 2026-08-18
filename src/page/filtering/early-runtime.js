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

  const preventTimer = (args, interval) => {
    const name = interval ? 'setInterval' : 'setTimeout';
    const key = `prevent-timer:${name}:${JSON.stringify(args)}`;
    const original = globalThis[name];
    if (typeof original !== 'function' || wrappers.has(key)) return false;
    const wrapped = function (handler, timeout, ...rest) {
      if (matches(typeof handler === 'function' ? handler.toString() : handler, args[0] || '')) return 0;
      return original(handler, timeout, ...rest);
    };
    globalThis[name] = wrapped;
    // Sloppy-mode assignment to a frozen intrinsic fails SILENTLY — verify the
    // wrapper actually stuck; a miss is an environmental failure and is counted.
    if (globalThis[name] !== wrapped) throw new Error('wrapper did not stick');
    wrappers.add(key);
    return true;
  };

  const adjustTimer = (args, interval) => {
    if (args.length < 1 || args.length > 3) return false;
    const funcPattern = args[0] || '';
    const delayPattern = args[1] || '';
    if (!funcPattern) return false;
    const boost = args[2] ? Number(args[2]) : 0.05;
    if (!Number.isFinite(boost) || boost <= 0 || boost > 1) return false;
    const name = interval ? 'setInterval' : 'setTimeout';
    const key = `adjust:${name}:${JSON.stringify(args)}`;
    const original = globalThis[name];
    if (typeof original !== 'function' || wrappers.has(key)) return false;
    const wrapped = function (handler, timeout, ...rest) {
      const sourceHit = matches(typeof handler === 'function' ? handler.toString() : handler, funcPattern);
      const delayHit = !delayPattern || matches(String(timeout ?? ''), delayPattern);
      const adjusted = sourceHit && delayHit ? (timeout ?? 0) * (1 / boost) : timeout;
      return original(handler, adjusted, ...rest);
    };
    globalThis[name] = wrapped;
    if (globalThis[name] !== wrapped) throw new Error('wrapper did not stick');
    wrappers.add(key);
    return true;
  };

  const preventAddEventListener = (args) => {
    if (args.length < 1 || args.length > 2) return false;
    const typePattern = args[0] || '';
    const handlerPattern = args[1] || '';
    if (!typePattern && !handlerPattern) return false;
    const key = `ael:${typePattern}:${handlerPattern}`;
    if (wrappers.has(key) || typeof EventTarget === 'undefined') return false;
    const original = EventTarget.prototype.addEventListener;
    if (typeof original !== 'function') return false;
    const wrapped = function (type, listener, ...rest) {
      const typeHit = !typePattern || matches(String(type), typePattern);
      if (typeHit && listener) {
        const source = typeof listener === 'function' ? listener.toString() : String(listener.handleEvent ?? '');
        if (!handlerPattern || matches(source, handlerPattern)) return;
      } else if (typeHit && !handlerPattern) {
        return;
      }
      return original.call(this, type, listener, ...rest);
    };
    EventTarget.prototype.addEventListener = wrapped;
    if (EventTarget.prototype.addEventListener !== wrapped) throw new Error('wrapper did not stick');
    wrappers.add(key);
    return true;
  };

  const setCookie = (args) => {
    if (args.length !== 2 || typeof document === 'undefined') return false;
    const cookieName = args[0] || '';
    const cookieValue = args[1] || '';
    if (!/^[A-Za-z0-9_!#$%&'*+.^`|~-]{1,64}$/.test(cookieName)) return false;
    if (!/^[\w%+./=-]{0,100}$/.test(cookieValue)) return false;
    try {
      document.cookie = `${cookieName}=${cookieValue}; path=/`;
      return true;
    } catch {
      return false;
    }
  };

  const storageString = (valueName) => {
    if (valueName === '') return '';
    if (/^-?\d{1,6}(?:\.\d{1,3})?$/.test(valueName)) return valueName;
    if (valueName === 'undefined' || valueName === 'null' || valueName === 'true' || valueName === 'false') return valueName;
    if (valueName === 'emptyObj') return '{}';
    if (valueName === 'emptyArray' || valueName === 'emptyArr') return '[]';
    return null;
  };

  const safeStorage = (kind) => {
    try {
      return globalThis[kind];
    } catch {
      return undefined;
    }
  };

  const setStorageItem = (args, storage) => {
    if (!storage || args.length !== 2) return false;
    const keyName = args[0] || '';
    if (!/^[\w$.-]{1,128}$/.test(keyName)) return false;
    const valueName = args[1] || '';
    try {
      if (valueName === '$remove$') {
        storage.removeItem(keyName);
        return true;
      }
      const stored = storageString(valueName);
      if (stored === null) return false;
      storage.setItem(keyName, stored);
      return true;
    } catch {
      return false;
    }
  };

  const preventElementSrcLoading = (args) => {
    if (args.length !== 2 || typeof document === 'undefined') return false;
    const tag = (args[0] || '').toLowerCase();
    if (!/^(script|img|iframe|video|audio|source|embed)$/.test(tag)) return false;
    const pattern = args[1] || '';
    if (!pattern) return false;
    const key = `elsrc:${tag}:${pattern}`;
    if (wrappers.has(key)) return false;
    let holder;
    try {
      holder = Object.getPrototypeOf(document.createElement(tag));
    } catch {
      return false;
    }
    let descriptor;
    while (holder && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(holder, 'src');
      if (!descriptor) holder = Object.getPrototypeOf(holder);
    }
    if (!descriptor || typeof descriptor.set !== 'function' || typeof descriptor.get !== 'function') return false;
    const originalGet = descriptor.get;
    const originalSet = descriptor.set;
    try {
      Object.defineProperty(holder, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function () {
          return originalGet.call(this);
        },
        set: function (value) {
          if (matches(String(value), pattern)) return;
          return originalSet.call(this, value);
        },
      });
      wrappers.add(key);
      return true;
    } catch {
      return false;
    }
  };


  const preventEvalIf = (args) => {
    const key = JSON.stringify(args);
    const original = globalThis.eval;
    if (typeof original !== 'function' || wrappers.has(key)) return false;
    const wrapped = function (source) {
      if (matches(source, args[0] || '')) return undefined;
      return original.call(this, source);
    };
    globalThis.eval = wrapped;
    if (globalThis.eval !== wrapped) throw new Error('wrapper did not stick');
    wrappers.add(key);
    return true;
  };

  const preventWindowOpen = (args) => {
    const key = JSON.stringify(args);
    const original = globalThis.open;
    if (typeof original !== 'function' || wrappers.has(key)) return false;
    const wrapped = function (url, target, features) {
      if (matches(url, args.filter(Boolean).join('|'))) return null;
      return original.call(this, url, target, features);
    };
    globalThis.open = wrapped;
    if (globalThis.open !== wrapped) throw new Error('wrapper did not stick');
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
    const wrapped = function (text, reviver) {
      const value = original.call(JSON, text, reviver);
      prunePaths(value, args);
      return value;
    };
    JSON.parse = wrapped;
    if (JSON.parse !== wrapped) throw new Error('wrapper did not stick');
    wrappers.add(key);
    return true;
  };

  const apply = (name, args) => {
    if (name === 'set-constant') return setConstant(args);
    if (name === 'abort-on-property-read') return abortOnRead(args, false);
    if (name === 'abort-on-property-write') return abortOnRead(args, true);
    if (name === 'abort-current-inline-script') return abortCurrentInlineScript(args);
    if (name === 'prevent-setTimeout') return preventTimer(args, false);
    if (name === 'prevent-setInterval') return preventTimer(args, true);
    if (name === 'adjust-setInterval') return adjustTimer(args, true);
    if (name === 'adjust-setTimeout') return adjustTimer(args, false);
    if (name === 'prevent-addEventListener') return preventAddEventListener(args);
    if (name === 'set-cookie') return setCookie(args);
    if (name === 'set-local-storage-item') return setStorageItem(args, safeStorage('localStorage'));
    if (name === 'set-session-storage-item') return setStorageItem(args, safeStorage('sessionStorage'));
    if (name === 'prevent-element-src-loading') return preventElementSrcLoading(args);
    if (name === 'prevent-eval-if') return preventEvalIf(args);
    if (name === 'prevent-window-open') return preventWindowOpen(args);
    if (name === 'json-prune') return jsonPrune(args);
    return false;
  };

  const host = location.hostname.toLowerCase();
  // Aggregate silent-failure telemetry: on a hostile page (frozen intrinsics,
  // locked prototypes) a rule that cannot apply must never abort the remaining
  // rules for the same domain, and the failure must be countable. The counter
  // is a single non-enumerable neutral-named number — no attribute markers,
  // no per-rule detail, nothing a detector can distinguish from page noise.
  let shardFailures = 0;
  for (const [domain, rules] of Object.entries(groups)) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      for (const rule of rules) {
        try {
          apply(rule && rule.name, rule && rule.args);
        } catch {
          shardFailures += 1;
        }
      }
    }
  }
  if (shardFailures > 0) {
    try {
      Object.defineProperty(globalThis, '__eshf', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: shardFailures,
      });
    } catch {
      /* frozen global — the count simply stays unreadable */
    }
  }
})();
