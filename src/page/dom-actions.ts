import { DomAction } from '../shared/types';
import { OpaqueTargetRegistry } from './opaque-targets';
import { safeGetBoundingClientRect, safeGetComputedStyle } from './dom-safety';

export interface AppliedDomActionRecord {
  action: DomAction;
  injectedStyleElement?: HTMLStyleElement;
  mutatedElements: Array<{
    element: HTMLElement;
    originalStyles: Record<string, string>;
  }>;
  /** Stable selectors for elements this action hid — captured at apply time so a
   * verified-healthy hide can be persisted per site and replayed as pre-paint CSS. */
  hideSelectors: string[];
}

/**
 * Reinsertion warfare (P4): every hide mechanism used to be one-shot — a detector
 * that re-inserted its wall or reset `display` won by default. A successful hide
 * now installs a BOUNDED watch (TTL 20s, max 25 re-hides) that re-hides re-shown
 * or re-inserted matches and counts the re-hides. On exhaustion the watch stops
 * and the existing mutation-signal path (rapidReinsertionDetected → survivor AI)
 * takes the escalation from there — the deterministic layer never fights forever.
 */
const REHIDE_TTL_MS = 20_000;
const REHIDE_MAX = 25;
const REHIDE_COALESCE_MS = 50;
/** Each watch is a full-document MutationObserver — cap concurrency so a page
 * that triggers many hides cannot multiply observers without bound. When the
 * cap is reached the OLDEST watch settles first (its TTL endgame arrives
 * early; escalation still flows through the mutation-signal path). */
const MAX_REHIDE_WATCHES = 4;
/** Cap on elements hidden by one dynamic full-screen overlay sweep — the scan
 * walks every div/section/aside/dialog in the document, so a runaway sweep on
 * a huge page must not hide unboundedly many candidates. */
const MAX_OVERLAY_SWEEP_HIDES = 8;

interface RehideWatch {
  observer: MutationObserver;
  ttlTimer: number;
  count: number;
  pending: boolean;
  stopped: boolean;
}

const HIDE_ACTION_TYPES = new Set(['DOM_REMOVE_OVERLAY', 'DOM_COLLAPSE', 'DOM_HIDE']);

const STABLE_IDENT = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;

/**
 * Conservative stable-selector derivation for persistence: a unique #id, else
 * tag + up to two static-looking classes matching at most a handful of
 * elements. Positional/attribute selectors are never emitted — they are the
 * fragile end of the grammar. Returns null when nothing safe exists.
 */
export function computeStableHideSelector(el: HTMLElement): string | null {
  try {
    const id = typeof el.id === 'string' ? el.id.trim() : '';
    if (id && STABLE_IDENT.test(id)) {
      const selector = `#${id}`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    const tag = el.tagName.toLowerCase();
    const classes = (typeof el.className === 'string' ? el.className : '')
      .trim()
      .split(/\s+/)
      .filter((name) => STABLE_IDENT.test(name))
      .slice(0, 2);
    if (classes.length > 0) {
      const selector = `${tag}.${classes.join('.')}`;
      const matches = document.querySelectorAll(selector).length;
      if (matches >= 1 && matches <= 5) return selector;
    }
  } catch {
    /* malformed tree state — no selector */
  }
  return null;
}

/**
 * Sanitizes CSS selector to prevent CSS injection vulnerabilities.
 */
function sanitizeCssSelector(selector: string): string {
  // Reject selectors containing curly braces or closing style tags
  if (/[{}<>]/.test(selector)) {
    throw new Error('Invalid characters in CSS selector');
  }
  return selector.trim();
}

export class DomActionExecutor {
  private appliedActions = new Map<string, AppliedDomActionRecord>();
  private rehideWatches = new Map<string, RehideWatch>();

  constructor(
    private readonly targets?: OpaqueTargetRegistry,
    /** Settled telemetry: fired once when a re-hide watch stops (TTL, cap, or
     * rollback) with the number of reinsertions it suppressed. */
    private readonly onRehideSettled?: (actionId: string, reHideCount: number) => void
  ) {}

  private targetElements(action: DomAction): HTMLElement[] | null {
    if (action.targetRef) {
      const element = this.targets?.resolve(action.targetRef);
      return element ? [element] : [];
    }
    return null;
  }

  private baitTargets(action: DomAction): HTMLElement[] | null {
    if (!action.targetRef || action.selector) return null;
    return this.targetElements(action);
  }

  public applyAction(action: DomAction): boolean {
    // Deterministic recipe fast-path actions may be re-sent after an MV3
    // worker restart. Treat an already-applied action ID as an idempotent ACK
    // instead of overwriting the original rollback snapshot.
    if (this.appliedActions.has(action.id)) return true;
    if (action.targetRef && !this.targets?.resolve(action.targetRef)) return false;
    const record: AppliedDomActionRecord = {
      action,
      mutatedElements: [],
      hideSelectors: [],
    };

    const captureHide = (htmlEl: HTMLElement): void => {
      const selector = computeStableHideSelector(htmlEl);
      if (selector && !record.hideSelectors.includes(selector) && record.hideSelectors.length < 4) {
        record.hideSelectors.push(selector);
      }
    };

    try {
      switch (action.type) {
        case 'DOM_REMOVE_OVERLAY':
        case 'DOM_COLLAPSE': {
          const opaqueTargets = this.targetElements(action);
          if (opaqueTargets !== null) {
            opaqueTargets.forEach((htmlEl) => {
              record.mutatedElements.push({ element: htmlEl, originalStyles: { display: htmlEl.style.display } });
              htmlEl.style.setProperty('display', 'none', 'important');
              captureHide(htmlEl);
            });
          } else if (action.selector) {
            const safeSelector = sanitizeCssSelector(action.selector);
            const elements = document.querySelectorAll(safeSelector);
            elements.forEach((el) => {
              const htmlEl = el as HTMLElement;
              record.mutatedElements.push({
                element: htmlEl,
                originalStyles: { display: htmlEl.style.display },
              });
              htmlEl.style.setProperty('display', 'none', 'important');
            });
            if (elements.length > 0 && record.hideSelectors.length < 4) record.hideSelectors.push(safeSelector);
          } else {
            // Remove full-screen overlays found dynamically — bounded sweep:
            // stop after MAX_OVERLAY_SWEEP_HIDES hides so a hostile page with
            // thousands of fixed-position nodes cannot force an unbounded scan.
            const candidates = document.querySelectorAll('div, section, aside, dialog');
            const vWidth = window.innerWidth;
            const vHeight = window.innerHeight;
            let sweepHides = 0;
            for (const el of candidates) {
              if (sweepHides >= MAX_OVERLAY_SWEEP_HIDES) break;
              const htmlEl = el as HTMLElement;
              const style = safeGetComputedStyle(htmlEl);
              const rect = safeGetBoundingClientRect(htmlEl);
              if (!style || !rect) continue;

              if (style.position === 'fixed' || style.position === 'absolute') {
                if (rect.width >= vWidth * 0.7 && rect.height >= vHeight * 0.7) {
                  record.mutatedElements.push({
                    element: htmlEl,
                    originalStyles: { display: htmlEl.style.display },
                  });
                  htmlEl.style.setProperty('display', 'none', 'important');
                  captureHide(htmlEl);
                  sweepHides += 1;
                }
              }
            }
          }
          break;
        }

        case 'DOM_RESTORE_SCROLL': {
          // Restore body & html scroll
          if (document.body) {
            record.mutatedElements.push({
              element: document.body,
                originalStyles: {
                  overflow: document.body.style.overflow,
                'overflow-y': document.body.style.overflowY,
                  position: document.body.style.position,
              },
            });
            document.body.style.setProperty('overflow', 'auto', 'important');
            document.body.style.setProperty('overflow-y', 'auto', 'important');
            if (document.body.style.position === 'fixed') {
              document.body.style.setProperty('position', 'static', 'important');
            }
          }
          if (document.documentElement) {
            record.mutatedElements.push({
              element: document.documentElement,
                originalStyles: {
                  overflow: document.documentElement.style.overflow,
                'overflow-y': document.documentElement.style.overflowY,
                  position: document.documentElement.style.position,
              },
            });
            document.documentElement.style.setProperty('overflow', 'auto', 'important');
            document.documentElement.style.setProperty('overflow-y', 'auto', 'important');
            if (document.documentElement.style.position === 'fixed') {
              document.documentElement.style.setProperty('position', 'static', 'important');
            }
          }
          break;
        }

        case 'DOM_RESTORE_POINTER_EVENTS': {
          if (document.body) {
            record.mutatedElements.push({
              element: document.body,
              originalStyles: { 'pointer-events': document.body.style.pointerEvents },
            });
            document.body.style.setProperty('pointer-events', 'auto', 'important');
          }
          break;
        }

        case 'DOM_RESTORE_PLAYER': {
          document.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => {
            record.mutatedElements.push({
              element: media as unknown as HTMLElement,
              originalStyles: { 'pointer-events': (media as HTMLElement).style.pointerEvents },
            });
            (media as HTMLElement).style.setProperty('pointer-events', 'auto', 'important');
            void media.play().catch(() => undefined);
          });
          break;
        }

        case 'DOM_PRESERVE_BAIT_CANDIDATE':
        case 'BAIT_PRESERVE_LAYOUT':
        case 'BAIT_RESTORE_VISIBILITY':
        case 'BAIT_DISABLE_COSMETIC_HIDE':
        case 'BAIT_PRESERVE_CHILD_STRUCTURE': {
          const baits = this.baitTargets(action);
          if (!baits) return false;
          baits.forEach((htmlEl) => {
            const computed = safeGetComputedStyle(htmlEl);
            const originalStyles: Record<string, string> = {
              display: htmlEl.style.display,
              visibility: htmlEl.style.visibility,
            };
            if (action.type !== 'BAIT_PRESERVE_CHILD_STRUCTURE') {
              originalStyles['content-visibility'] = htmlEl.style.contentVisibility;
              originalStyles.contain = htmlEl.style.contain;
            }
            record.mutatedElements.push({ element: htmlEl, originalStyles });

            if (action.type === 'BAIT_PRESERVE_CHILD_STRUCTURE') return;
            if (computed?.display === 'none') htmlEl.style.setProperty('display', 'revert', 'important');
            if (computed?.visibility === 'hidden' || computed?.visibility === 'collapse') {
              htmlEl.style.setProperty('visibility', 'revert', 'important');
            }
            if (action.type === 'BAIT_PRESERVE_LAYOUT') {
              if (computed?.contentVisibility === 'hidden') htmlEl.style.setProperty('content-visibility', 'revert', 'important');
              if (computed?.contain === 'strict' || computed?.contain === 'content') htmlEl.style.setProperty('contain', 'revert', 'important');
            }
          });
          break;
        }

        case 'DOM_HIDE': {
          const opaqueTargets = this.targetElements(action);
          if (opaqueTargets !== null) {
            opaqueTargets.forEach((htmlEl) => {
              record.mutatedElements.push({ element: htmlEl, originalStyles: { display: htmlEl.style.display } });
              htmlEl.style.setProperty('display', 'none', 'important');
              captureHide(htmlEl);
            });
          } else if (action.selector) {
            const safeSelector = sanitizeCssSelector(action.selector);
            const style = document.createElement('style');
            style.textContent = `${safeSelector} { display: none !important; }`;
            document.head?.appendChild(style);
            record.injectedStyleElement = style;
            record.hideSelectors.push(safeSelector);
          }
          break;
        }

        case 'DOM_RESTORE': {
          if (action.styleId) {
            this.rollbackAction(action.styleId);
          }
          break;
        }
      }

      this.appliedActions.set(action.id, record);
      if (HIDE_ACTION_TYPES.has(action.type) && (record.mutatedElements.length > 0 || record.injectedStyleElement)) {
        this.installRehideWatch(action.id, record);
      }
      return true;
    } catch {
      return false;
    }
  }

  private installRehideWatch(actionId: string, record: AppliedDomActionRecord): void {
    if (typeof MutationObserver === 'undefined' || typeof window === 'undefined') return;
    // Cap concurrent full-document observers: the oldest watch settles first.
    while (this.rehideWatches.size >= MAX_REHIDE_WATCHES) {
      const oldest = this.rehideWatches.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.stopRehideWatch(oldest);
    }
    const watch: RehideWatch = { observer: null as unknown as MutationObserver, ttlTimer: 0, count: 0, pending: false, stopped: false };

    const sweep = (): void => {
      watch.pending = false;
      if (watch.stopped) return;
      // Re-show on the exact elements we hid (style/class reset by the page).
      for (const mutated of record.mutatedElements) {
        if (watch.count >= REHIDE_MAX) break;
        const el = mutated.element;
        if (!el.isConnected) continue;
        const display = safeGetComputedStyle(el)?.display;
        if (display && display !== 'none') {
          el.style.setProperty('display', 'none', 'important');
          watch.count += 1;
        }
      }
      // Re-inserted clones matching the captured selectors.
      for (const selector of record.hideSelectors) {
        if (watch.count >= REHIDE_MAX) break;
        let found: NodeListOf<Element>;
        try {
          found = document.querySelectorAll(selector);
        } catch {
          continue;
        }
        for (const node of found) {
          if (watch.count >= REHIDE_MAX) break;
          const el = node as HTMLElement;
          const display = safeGetComputedStyle(el)?.display;
          if (display && display !== 'none') {
            el.style.setProperty('display', 'none', 'important');
            watch.count += 1;
          }
        }
      }
      // A detector that removes our injected stylesheet gets it re-appended.
      if (watch.count < REHIDE_MAX && record.injectedStyleElement && !record.injectedStyleElement.isConnected) {
        document.head?.appendChild(record.injectedStyleElement);
        watch.count += 1;
      }
      if (watch.count >= REHIDE_MAX) this.stopRehideWatch(actionId);
    };

    try {
      watch.observer = new MutationObserver(() => {
        // Our own re-hide writes retrigger the observer; the sweep's display
        // check is a natural no-op on them, and coalescing keeps it cheap.
        if (watch.pending || watch.stopped) return;
        watch.pending = true;
        window.setTimeout(sweep, REHIDE_COALESCE_MS);
      });
      watch.observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      watch.ttlTimer = window.setTimeout(() => this.stopRehideWatch(actionId), REHIDE_TTL_MS);
      this.rehideWatches.set(actionId, watch);
    } catch {
      /* observer unsupported — one-shot hide stands */
    }
  }

  private stopRehideWatch(actionId: string): void {
    const watch = this.rehideWatches.get(actionId);
    if (!watch || watch.stopped) return;
    watch.stopped = true;
    watch.observer.disconnect();
    window.clearTimeout(watch.ttlTimer);
    this.rehideWatches.delete(actionId);
    if (watch.count > 0) this.onRehideSettled?.(actionId, watch.count);
  }

  /** Live re-hide count for an action (0 when no watch or nothing re-hidden yet). */
  public rehideCountFor(actionId: string): number {
    return this.rehideWatches.get(actionId)?.count ?? 0;
  }

  /** Selectors captured when hide-type actions were applied (for per-site persistence). */
  public hideSelectorsFor(actionId: string): string[] {
    return this.appliedActions.get(actionId)?.hideSelectors ?? [];
  }

  public rollbackAction(actionId: string): boolean {
    const record = this.appliedActions.get(actionId);
    if (!record) return false;

    // Stop the re-hide watch BEFORE reverting styles — otherwise the observer
    // sees the intentional restore as a re-show and fights the rollback.
    this.stopRehideWatch(actionId);

    // Remove injected style tag if any
    if (record.injectedStyleElement && record.injectedStyleElement.parentNode) {
      record.injectedStyleElement.parentNode.removeChild(record.injectedStyleElement);
    }

    // Revert inline style mutations
    for (const mutated of record.mutatedElements) {
      for (const [prop, originalValue] of Object.entries(mutated.originalStyles)) {
        mutated.element.style.removeProperty(prop);
        if (originalValue) {
          mutated.element.style.setProperty(prop, originalValue);
        }
      }
    }

    this.appliedActions.delete(actionId);
    return true;
  }

  public rollbackAll(): void {
    const actionIds = Array.from(this.appliedActions.keys());
    for (const id of actionIds) {
      this.rollbackAction(id);
    }
  }
}
