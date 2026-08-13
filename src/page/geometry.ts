import { GeometrySignal } from '../shared/types';
import { safeGetBoundingClientRect, safeGetComputedStyle } from './dom-safety';

/**
 * Computes DOM geometry and overlay coverage signals.
 *
 * Observation must never throw: a page may be replacing <body>, detaching
 * elements, or navigating while the mutation scheduler samples it.
 */
export function extractGeometrySignals(): GeometrySignal {
  const root = document.documentElement;
  const viewportWidth = window.innerWidth || root?.clientWidth || 1024;
  const viewportHeight = window.innerHeight || root?.clientHeight || 768;
  const viewportArea = Math.max(1, viewportWidth * viewportHeight);

  let hasFixedOverlay = false;
  let maxOverlayArea = 0;
  let modalCount = 0;

  const candidates = document.querySelectorAll('div, section, aside, dialog');

  for (let i = 0; i < candidates.length && i < 200; i++) {
    const el = candidates[i];
    const style = safeGetComputedStyle(el);
    const rect = safeGetBoundingClientRect(el);
    if (!style || !rect) continue;

    const pos = style.position;
    if (pos !== 'fixed' && pos !== 'sticky' && pos !== 'absolute') continue;

    const isVisible =
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      parseFloat(style.opacity || '1') > 0.1;

    if (!isVisible || rect.width <= 0 || rect.height <= 0) continue;

    const intersectionWidth = Math.max(
      0,
      Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0)
    );
    const intersectionHeight = Math.max(
      0,
      Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0)
    );
    const area = intersectionWidth * intersectionHeight;

    if (area > viewportArea * 0.35) {
      hasFixedOverlay = true;
      maxOverlayArea = Math.max(maxOverlayArea, area);
      modalCount++;
    }
  }

  const bodyStyle = safeGetComputedStyle(document.body);
  const htmlStyle = safeGetComputedStyle(document.documentElement);

  const bodyScrollLocked =
    bodyStyle !== null &&
    (bodyStyle.overflow === 'hidden' ||
      bodyStyle.overflowY === 'hidden' ||
      bodyStyle.position === 'fixed');

  const htmlScrollLocked =
    htmlStyle !== null &&
    (htmlStyle.overflow === 'hidden' ||
      htmlStyle.overflowY === 'hidden' ||
      htmlStyle.position === 'fixed');

  const mainEl = document.querySelector('main, article, #content, .content, #main');
  const mainStyle = safeGetComputedStyle(mainEl);
  const mainRect = safeGetBoundingClientRect(mainEl);

  const mainContentHidden =
    mainStyle !== null &&
    (mainStyle.display === 'none' ||
      mainStyle.visibility === 'hidden' ||
      parseFloat(mainStyle.opacity || '1') < 0.05);

  const mainContentHeight = mainRect?.height ?? 0;
  const overlayCoverageRatio = Math.min(1, maxOverlayArea / viewportArea);

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
