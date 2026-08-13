import { safeGetComputedStyle } from '../dom-safety';

export type ScriptletResult = 'applied' | 'skipped' | 'failed';

function query(selector: string): Element[] {
  try {
    return [...document.querySelectorAll(selector)].slice(0, 500);
  } catch {
    return [];
  }
}

function validAttributeName(value: string): boolean {
  return /^[a-zA-Z_:][\w:.-]{0,100}$/.test(value);
}

export function applyIsolatedScriptlet(name: string, args: string[]): ScriptletResult {
  try {
    if (name === 'remove-attr') {
      const attribute = args[0] || '';
      const selector = args[1] || '*';
      if (!validAttributeName(attribute)) return 'skipped';
      for (const element of query(selector)) element.removeAttribute(attribute);
      return 'applied';
    }

    if (name === 'remove-class') {
      const className = args[0] || '';
      const selector = args[1] || '*';
      if (!/^[\w-]{1,100}$/.test(className)) return 'skipped';
      for (const element of query(selector)) element.classList.remove(className);
      return 'applied';
    }

    if (name === 'remove-node-attr') {
      const selector = args[0] || '*';
      const attribute = args[1] || '';
      if (!validAttributeName(attribute)) return 'skipped';
      for (const element of query(selector)) element.removeAttribute(attribute);
      return 'applied';
    }

    if (name === 'remove-node-text') {
      const selector = args[0] || 'script';
      const needle = args[1] || '';
      for (const element of query(selector)) {
        const text = element.textContent || '';
        if (needle.startsWith('/') && needle.endsWith('/')) {
          const pattern = needle.slice(1, -1);
          try {
            if (new RegExp(pattern).test(text)) element.textContent = '';
          } catch {
            return 'skipped';
          }
        } else if (text.includes(needle)) {
          element.textContent = '';
        }
      }
      return 'applied';
    }

    return 'skipped';
  } catch {
    return 'failed';
  }
}

export function applyProceduralRule(
  kind: 'has-text' | 'matches-css' | 'remove' | 'remove-attr',
  selector: string,
  argument?: string,
  property?: string,
  value?: string
): number {
  let count = 0;
  let candidates: Element[];
  try {
    candidates = [...document.querySelectorAll(selector)].slice(0, 500);
  } catch {
    return 0;
  }

  for (const element of candidates) {
    try {
      if (kind === 'has-text' && !(element.textContent || '').toLowerCase().includes((argument || '').toLowerCase())) continue;
      if (kind === 'matches-css') {
        const style = safeGetComputedStyle(element);
        if (!style || !property) continue;
        const actual = style.getPropertyValue(property).trim();
        const expected = value || '';
        if (expected.startsWith('/') && expected.endsWith('/')) {
          try {
            if (!new RegExp(expected.slice(1, -1), 'i').test(actual)) continue;
          } catch {
            continue;
          }
        } else if (actual !== expected) continue;
      }

      if (kind === 'remove') element.remove();
      else if (kind === 'remove-attr' && argument) element.removeAttribute(argument);
      else (element as HTMLElement).style.setProperty('display', 'none', 'important');
      count++;
    } catch {
      continue;
    }
  }

  return count;
}
