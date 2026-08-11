import { NavigationEpoch } from '../../shared/types';

/**
 * Extracts a normalized site key (root domain/hostname) from a given URL.
 */
export function extractSiteKey(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }
    const hostname = parsed.hostname.toLowerCase();
    // Strip leading 'www.'
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  } catch {
    return '';
  }
}

/**
 * Creates a unique navigation ID for a new document epoch.
 */
export function createNavigationId(tabId: number, frameId: number): string {
  return `nav_${tabId}_${frameId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Constructs a new NavigationEpoch.
 */
export function createNavigationEpoch(
  tabId: number,
  frameId: number,
  url: string,
  parentFrameId?: number
): NavigationEpoch {
  const origin = new URL(url).origin;
  const siteKey = extractSiteKey(url);

  return {
    tabId,
    navigationId: createNavigationId(tabId, frameId),
    frameId,
    parentFrameId,
    url,
    origin,
    siteKey,
    startTime: Date.now(),
    isMainFrame: frameId === 0,
  };
}
