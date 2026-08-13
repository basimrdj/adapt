import { InteractionSignal } from '../shared/types';
import { safeGetBoundingClientRect, safeGetComputedStyle } from './dom-safety';

/**
 * Checks interactivity health indicators (pointer-events, scroll locks,
 * content obstruction). All reads are tolerant of document-start and SPA
 * teardown/replacement states.
 */
export function extractInteractionSignals(): InteractionSignal {
  const bodyStyle = safeGetComputedStyle(document.body);

  const pointerEventsSuppressed = bodyStyle?.pointerEvents === 'none';
  const bodyOverflowHidden =
    bodyStyle !== null &&
    (bodyStyle.overflow === 'hidden' || bodyStyle.overflowY === 'hidden');

  let contentCovered = false;
  const mainEl = document.querySelector('main, article, #content, .content, #main');
  const rect = safeGetBoundingClientRect(mainEl);

  if (mainEl && rect && rect.width > 50 && rect.height > 50) {
    const centerX = rect.left + rect.width / 2;
    const centerY = Math.min(window.innerHeight / 2, rect.top + rect.height / 2);

    if (
      centerX >= 0 &&
      centerX <= window.innerWidth &&
      centerY >= 0 &&
      centerY <= window.innerHeight
    ) {
      let topEl: Element | null = null;
      try {
        topEl = document.elementFromPoint(centerX, centerY);
      } catch {
        topEl = null;
      }

      if (
        topEl &&
        !mainEl.contains(topEl) &&
        topEl !== mainEl &&
        topEl !== document.body &&
        topEl !== document.documentElement
      ) {
        contentCovered = true;
      }
    }
  }

  return {
    pointerEventsSuppressed,
    bodyOverflowHidden,
    contentCovered,
  };
}
