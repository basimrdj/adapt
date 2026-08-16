import { OpaqueElementObservation, SemanticSignal } from '../shared/types';
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

  observe(semantic?: SemanticSignal): OpaqueElementObservation[] {
    this.pruneDisconnected();

    const out: OpaqueElementObservation[] = [];
    const emitted = new Set<string>();
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const emit = (element: HTMLElement, role: OpaqueElementObservation['role'], visible: boolean, coverage: number): void => {
      const ref = this.register(element);
      if (emitted.has(ref)) return;
      emitted.add(ref);
      out.push({ ref, role, viewportCoverage: coverage, visible });
    };
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

      emit(el, overlay ? 'fullscreen-overlay' : 'bait-candidate', visible, coverage);
    }

    const categories = semantic?.categories ?? [];
    const semanticConfidence = semantic?.confidenceScore ?? 0;
    const semanticEnabled = semanticConfidence >= 0.65 && categories.some((category) =>
      category === 'ANTI_BLOCK_INSTRUCTION' ||
      category === 'PLAYBACK_GATE' ||
      category === 'INTERACTION_DENIAL'
    );
    if (!semanticEnabled) return out;

    const reactionPattern = /(?:disable|turn\s+off|allow|whitelist|detected|blocked|unavailable|enable|continue).{0,90}(?:adblock|ad\s*blocker|blocker|advertising|play|watch|video|interaction)|(?:adblock|ad\s*blocker|blocker).{0,90}(?:detected|disable|turn\s+off|whitelist|blocked)/i;
    const structuralPenalty = new Set(['main', 'article', 'nav', 'footer', 'header']);
    const nodes = document.querySelectorAll<HTMLElement>('body *');
    const seenCandidates = new Set<HTMLElement>();
    for (let index = 0; index < nodes.length && index < 900; index += 1) {
      const node = nodes[index];
      if (!node || seenCandidates.has(node)) continue;
      let text = '';
      try {
        text = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500);
      } catch {
        continue;
      }
      if (!text || !reactionPattern.test(text)) continue;

      let current: HTMLElement | null = node;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        if (seenCandidates.has(current)) continue;
        const style = safeGetComputedStyle(current);
        const rect = safeGetBoundingClientRect(current);
        if (!style || !rect || rect.width <= 0 || rect.height <= 0) continue;
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.1;
        if (!visible) continue;

        const tag = current.tagName.toLowerCase();
        const role = current.getAttribute('role') || '';
        const ariaLive = current.getAttribute('aria-live') || '';
        const classTokens = `${current.id || ''} ${typeof current.className === 'string' ? current.className : ''}`;
        const fixedLike = style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute';
        const semanticUi = role === 'alert' || role === 'status' || role === 'dialog' || Boolean(ariaLive);
        const namedReaction = /alert|warning|notice|toast|banner|modal|gate|blocker|adblock|overlay/i.test(classTokens);
        const coverage = Math.max(0, Math.min(1, (rect.width * rect.height) / viewportArea));
        const contentContainer = structuralPenalty.has(tag);
        const compact = text.length <= 500 && rect.width <= window.innerWidth * 0.98 && rect.height <= window.innerHeight * 0.65;
        const score =
          (semanticUi ? 3 : 0) +
          (namedReaction ? 2 : 0) +
          (fixedLike ? 2 : 0) +
          (compact ? 1 : 0) +
          (semanticConfidence >= 0.85 ? 1 : 0) -
          (contentContainer && !semanticUi && !fixedLike && !namedReaction ? 5 : 0);
        if (score < 4 || (contentContainer && !semanticUi && !fixedLike && !namedReaction)) continue;

        seenCandidates.add(current);
        emit(current, 'semantic-reaction-ui', true, coverage);
        break;
      }
    }

    return out;
  }
}
