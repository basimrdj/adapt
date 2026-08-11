import { DomAction } from '../shared/types';

export interface AppliedDomActionRecord {
  action: DomAction;
  injectedStyleElement?: HTMLStyleElement;
  mutatedElements: Array<{
    element: HTMLElement;
    originalStyles: Record<string, string>;
  }>;
}

export class DomActionExecutor {
  private appliedActions = new Map<string, AppliedDomActionRecord>();

  public applyAction(action: DomAction): boolean {
    const record: AppliedDomActionRecord = {
      action,
      mutatedElements: [],
    };

    try {
      switch (action.type) {
        case 'DOM_REMOVE_OVERLAY':
        case 'DOM_COLLAPSE': {
          if (action.selector) {
            const elements = document.querySelectorAll(action.selector);
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
              const style = window.getComputedStyle(htmlEl);
              if (style.position === 'fixed' || style.position === 'absolute') {
                const rect = htmlEl.getBoundingClientRect();
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
                overflowY: document.body.style.overflowY,
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
                overflowY: document.documentElement.style.overflowY,
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
              originalStyles: { pointerEvents: document.body.style.pointerEvents },
            });
            document.body.style.setProperty('pointer-events', 'auto', 'important');
          }
          break;
        }

        case 'DOM_PRESERVE_BAIT_CANDIDATE': {
          // Keep dummy layout bait elements dimensions without executing external scripts
          if (action.selector) {
            const baits = document.querySelectorAll(action.selector);
            baits.forEach((el) => {
              const htmlEl = el as HTMLElement;
              record.mutatedElements.push({
                element: htmlEl,
                originalStyles: {
                  display: htmlEl.style.display,
                  visibility: htmlEl.style.visibility,
                  height: htmlEl.style.height,
                  width: htmlEl.style.width,
                  opacity: htmlEl.style.opacity,
                },
              });
              htmlEl.style.setProperty('display', 'block', 'important');
              htmlEl.style.setProperty('visibility', 'visible', 'important');
              htmlEl.style.setProperty('width', '1px', 'important');
              htmlEl.style.setProperty('height', '1px', 'important');
              htmlEl.style.setProperty('opacity', '0.01', 'important');
            });
          }
          break;
        }

        case 'DOM_HIDE': {
          if (action.selector) {
            const style = document.createElement('style');
            style.textContent = `${action.selector} { display: none !important; }`;
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
        if (originalValue) {
          mutated.element.style.setProperty(prop, originalValue);
        } else {
          mutated.element.style.removeProperty(prop);
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
