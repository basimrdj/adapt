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

  constructor(private readonly targets?: OpaqueTargetRegistry) {}

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
          } else {
            // Remove full-screen overlays found dynamically
            const candidates = document.querySelectorAll('div, section, aside, dialog');
            const vWidth = window.innerWidth;
            const vHeight = window.innerHeight;
            candidates.forEach((el) => {
              const htmlEl = el as HTMLElement;
              const style = safeGetComputedStyle(htmlEl);
              const rect = safeGetBoundingClientRect(htmlEl);
              if (!style || !rect) return;

              if (style.position === 'fixed' || style.position === 'absolute') {
                if (rect.width >= vWidth * 0.7 && rect.height >= vHeight * 0.7) {
                  record.mutatedElements.push({
                    element: htmlEl,
                    originalStyles: { display: htmlEl.style.display },
                  });
                  htmlEl.style.setProperty('display', 'none', 'important');
                }
              }
            });
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
            });
          } else if (action.selector) {
            const safeSelector = sanitizeCssSelector(action.selector);
            const style = document.createElement('style');
            style.textContent = `${safeSelector} { display: none !important; }`;
            document.head?.appendChild(style);
            record.injectedStyleElement = style;
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
      return true;
    } catch {
      return false;
    }
  }

  public rollbackAction(actionId: string): boolean {
    const record = this.appliedActions.get(actionId);
    if (!record) return false;

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
