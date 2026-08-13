export function runMainScriptlet(name: string, args: string[]): boolean {
  if (name !== 'set-constant') return false;

  const property = args[0] || '';
  const valueName = args[1] || 'undefined';
  if (!/^[A-Za-z_$][\w$]{0,63}$/.test(property)) return false;

  const values: Record<string, unknown> = {
    undefined,
    null: null,
    true: true,
    false: false,
    noopFunc: () => undefined,
    emptyObj: Object.freeze({}),
    emptyArr: Object.freeze([]),
  };
  if (!(valueName in values)) return false;

  try {
    Object.defineProperty(globalThis, property, {
      configurable: false,
      enumerable: false,
      get: () => values[valueName],
      set: () => undefined,
    });
    return true;
  } catch {
    return false;
  }
}
