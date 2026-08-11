import { GeometrySignal } from '../shared/types';

/**
 * Computes DOM geometry and overlay coverage signals.
 */
export function extractGeometrySignals(): GeometrySignal {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const viewportArea = viewportWidth * viewportHeight;

  let hasFixedOverlay = false;
  let maxOverlayArea = 0;
  let modalCount = 0;

  // Inspect elements with fixed/absolute positioning that cover substantial screen real estate
  const candidates = document.querySelectorAll('div, section, aside, dialog');
  for (let i = 0; i < candidates.length && i < 200; i++) {
    const el = candidates[i] as HTMLElement;
    if (!el || !el.getBoundingClientRect) continue;

    const style = window.getComputedStyle(el);
    const pos = style.position;
    if (pos === 'fixed' || pos === 'sticky' || pos === 'absolute') {
      const rect = el.getBoundingClientRect();
      const isVisible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        parseFloat(style.opacity || '1') > 0.1;

      if (isVisible && rect.width > 0 && rect.height > 0) {
        const intersectionWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
        const intersectionHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
        const area = intersectionWidth * intersectionHeight;

        if (area > viewportArea * 0.35) {
          hasFixedOverlay = true;
          maxOverlayArea = Math.max(maxOverlayArea, area);
          modalCount++;
        }
      }
    }
  }

  const bodyStyle = window.getComputedStyle(document.body);
  const htmlStyle = window.getComputedStyle(document.documentElement);

  const bodyScrollLocked =
    bodyStyle.overflow === 'hidden' ||
    bodyStyle.overflowY === 'hidden' ||
    bodyStyle.position === 'fixed';

  const htmlScrollLocked =
    htmlStyle.overflow === 'hidden' ||
    htmlStyle.overflowY === 'hidden' ||
    htmlStyle.position === 'fixed';

  // Main content presence check
  const mainEl = document.querySelector('main, article, #content, .content, #main');
  let mainContentHidden = false;
  let mainContentHeight = 0;

  if (mainEl) {
    const mainStyle = window.getComputedStyle(mainEl);
    mainContentHidden =
      mainStyle.display === 'none' ||
      mainStyle.visibility === 'hidden' ||
      parseFloat(mainStyle.opacity || '1') < 0.05;
    mainContentHeight = mainEl.getBoundingClientRect().height;
  }

  const overlayCoverageRatio = viewportArea > 0 ? Math.min(1, maxOverlayArea / viewportArea) : 0;

  return {
    viewportWidth,
    viewportHeight,
    hasFixedOverlay,
    overlayCoverageRatio,
    bodyScrollLocked,
    htmlScrollLocked,
    modalCount,
    mainContentHidden,
    mainContentHeight,
  };
}
