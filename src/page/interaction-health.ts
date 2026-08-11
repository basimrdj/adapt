import { InteractionSignal } from '../shared/types';

/**
 * Checks interactivity health indicators (pointer-events, scroll locks, content obstruction).
 */
export function extractInteractionSignals(): InteractionSignal {
  const bodyStyle = window.getComputedStyle(document.body);
  const pointerEventsSuppressed = bodyStyle.pointerEvents === 'none';
  const bodyOverflowHidden = bodyStyle.overflow === 'hidden' || bodyStyle.overflowY === 'hidden';

  // Check if main content element is covered by checking elementAtPoint
  let contentCovered = false;
  const mainEl = document.querySelector('main, article, #content, .content, #main');
  if (mainEl) {
    const rect = mainEl.getBoundingClientRect();
    if (rect.width > 50 && rect.height > 50) {
      const centerX = rect.left + rect.width / 2;
      const centerY = Math.min(window.innerHeight / 2, rect.top + rect.height / 2);

      if (centerX >= 0 && centerX <= window.innerWidth && centerY >= 0 && centerY <= window.innerHeight) {
        const topEl = document.elementFromPoint(centerX, centerY);
        if (topEl && !mainEl.contains(topEl) && topEl !== mainEl && topEl !== document.body && topEl !== document.documentElement) {
          contentCovered = true;
        }
      }
    }
  }

  return {
    pointerEventsSuppressed,
    bodyOverflowHidden,
    contentCovered,
  };
}
