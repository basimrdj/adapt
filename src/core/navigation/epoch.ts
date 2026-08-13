import { NavigationEpoch } from '../../shared/types';

const SYNTHETIC_DOCUMENT_PREFIX = 'missing:';

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
 * Phase 1 compatibility: string navigationId is retained alongside numeric navigationEpoch.
 */
export function createNavigationId(tabId: number, frameId: number): string {
  return `nav_${tabId}_${frameId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Synthetic document id used when Chrome's webNavigation.documentId is absent.
 * Unit tests and content-script fallbacks isolate documents via this prefix.
 * Production webNavigation handlers MUST pass Chrome's documentId.
 */
export function createSyntheticDocumentId(): string {
  return `${SYNTHETIC_DOCUMENT_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function isSyntheticDocumentId(documentId: string): boolean {
  return documentId.startsWith(SYNTHETIC_DOCUMENT_PREFIX);
}

function resolveDocumentId(documentId?: string): string {
  if (documentId && documentId.length > 0) {
    return documentId;
  }
  return createSyntheticDocumentId();
}

/**
 * Constructs a new NavigationEpoch.
 * `documentId` is Chrome's per-document UUID when provided; otherwise a unique `missing:` id.
 * `navigationEpoch` is the ADAPT-assigned monotonic per-tab counter (defaults to 1).
 * Never uses renderer processId — it is deprecated and not a causal identity.
 */
export function createNavigationEpoch(
  tabId: number,
  frameId: number,
  url: string,
  parentFrameId?: number,
  documentId?: string,
  navigationEpoch?: number
): NavigationEpoch {
  const origin = new URL(url).origin;
  const siteKey = extractSiteKey(url);

  return {
    tabId,
    navigationId: createNavigationId(tabId, frameId),
    documentId: resolveDocumentId(documentId),
    navigationEpoch: navigationEpoch ?? 1,
    frameId,
    parentFrameId,
    url,
    origin,
    siteKey,
    startTime: Date.now(),
    isMainFrame: frameId === 0,
  };
}
