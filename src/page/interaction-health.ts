import { InteractionSignal } from '../shared/types';

/**
 * Checks interactivity health indicators (pointer-events, scroll locks, content obstruction).
 */
export function extractInteractionSignals(): InteractionSignal {
  // At document_start the parser may not have created <body> yet.
  // Treat that transient state as "no body-level suppression observed" rather
  // than crashing the entire health-sensing pipeline.
  const bodyElement = document.body;
  let bodyStyle: CSSStyleDeclaration | null = null;
  if (bodyElement instanceof Element) {
    try {
      bodyStyle = window.getComputedStyle(bodyElement);
    } catch {
      bodyStyle = null;
    }
  }

  const pointerEventsSuppressed = bodyStyle?.pointerEvents === 'none';
  const bodyOverflowHidden =
    bodyStyle !== null &&
    (bodyStyle.overflow === 'hidden' || bodyStyle.overflowY === 'hidden');

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
