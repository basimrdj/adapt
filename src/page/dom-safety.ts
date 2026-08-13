/**
 * Browser pages are hostile/unstable observation targets. DOM nodes can be
 * detached between reads, bodies can be replaced during SPA transitions, and
 * cross-realm wrappers do not always behave well with instanceof checks.
 *
 * All low-level DOM reads used by the sensor must fail closed instead of
 * throwing into the content-script event loop.
 */
export function isElementNode(value: unknown): value is Element {
  if (value === null || typeof value !== 'object') return false;

  try {
    return (value as { nodeType?: unknown }).nodeType === 1;
  } catch {
    return false;
  }
}

export function safeGetComputedStyle(value: unknown): CSSStyleDeclaration | null {
  if (!isElementNode(value)) return null;

  try {
    return window.getComputedStyle(value);
  } catch {
    return null;
  }
}

export function safeGetBoundingClientRect(value: unknown): DOMRect | null {
  if (!isElementNode(value)) return null;

  try {
    return value.getBoundingClientRect();
  } catch {
    return null;
  }
}
