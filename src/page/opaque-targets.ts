import { OpaqueElementObservation } from '../shared/types';
import { safeGetBoundingClientRect, safeGetComputedStyle } from './dom-safety';

/** Owns the only mapping from opaque element refs to live DOM nodes. */
export class OpaqueTargetRegistry {
  private readonly byRef = new Map<`element:e${number}`, HTMLElement>();
  private readonly byElement = new WeakMap<HTMLElement, `element:e${number}`>();
  private next = 1;

  register(element: HTMLElement): `element:e${number}` {
    const existing = this.byElement.get(element);
    if (existing) return existing;

    const ref = `element:e${this.next++}` as const;
    this.byElement.set(element, ref);
    this.byRef.set(ref, element);
    return ref;
  }

  resolve(ref: `element:e${number}`): HTMLElement | undefined {
    const element = this.byRef.get(ref);
    if (!element?.isConnected) {
      this.byRef.delete(ref);
      return undefined;
    }
    return element;
  }

  private pruneDisconnected(): void {
    for (const [ref, element] of this.byRef.entries()) {
      if (!element.isConnected) this.byRef.delete(ref);
    }
  }

  observe(): OpaqueElementObservation[] {
    this.pruneDisconnected();

    const out: OpaqueElementObservation[] = [];
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const candidates = document.querySelectorAll<HTMLElement>(
      'div, section, aside, dialog, [class*="ad"], [id*="ad"]'
    );

    for (let i = 0; i < candidates.length && i < 250; i++) {
      const el = candidates[i];
      if (!el) continue;

      const style = safeGetComputedStyle(el);
      const rect = safeGetBoundingClientRect(el);
      if (!style || !rect) continue;

      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.1;

      const coverage = Math.max(
        0,
        Math.min(1, (rect.width * rect.height) / viewportArea)
      );

      const overlay =
        visible &&
        (style.position === 'fixed' || style.position === 'absolute') &&
        coverage >= 0.35;

      const className = typeof el.className === 'string' ? el.className : '';
      const bait = /(^|[\s_-])(ad|ads|advert|sponsor)([\s_-]|$)/i.test(
        `${el.id || ''} ${className}`
      );

      if (!overlay && !bait) continue;

      out.push({
        ref: this.register(el),
        role: overlay ? 'fullscreen-overlay' : 'bait-candidate',
        viewportCoverage: coverage,
        visible,
      });
    }

    return out;
  }
}
