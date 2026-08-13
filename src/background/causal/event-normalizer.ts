import { NavigationRegistry } from '../../core/navigation/registry';
import { isSyntheticDocumentId } from '../../core/navigation/epoch';
import { normalizeUrlForTelemetry } from '../../core/network/normalize-url';
import {
  clampConfidence,
  createEventId,
  EventKind,
  EventNode,
  hashOrigin,
  OpaqueRef,
  Timestamp,
} from '../../shared/causal/events';

export interface RawNavigationEvent {
  type: 'committed' | 'history' | 'start' | 'domReady' | 'completed';
  tabId: number;
  frameId: number;
  url: string;
  documentId?: string;
  timeStamp?: number; // Chrome event timeStamp, often monotonic ms
  parentFrameId?: number;
}

export interface RawRequestEvent {
  type: 'start' | 'complete' | 'error';
  tabId: number;
  frameId: number;
  requestId: string;
  url: string;
  documentId?: string;
  resourceType?: string;
  timeStamp?: number;
  error?: string;
  initiator?: string;
}

const CONFIDENCE_REAL_DOCUMENT = 1;
const CONFIDENCE_SYNTHETIC_DOCUMENT = 0.6;

function timestampFromChrome(timeStamp?: number): Timestamp {
  if (timeStamp !== undefined && Number.isFinite(timeStamp)) {
    return {
      value: timeStamp,
      // Chrome extension event timestamps are milliseconds since the epoch.
      domain: 'extension.wall_ms',
      capturedWallMs: Date.now(),
    };
  }
  return {
    value: Date.now(),
    domain: 'extension.wall_ms',
  };
}

function navigationKind(type: RawNavigationEvent['type']): EventKind {
  switch (type) {
    case 'start':
      return 'NAV_START';
    case 'committed':
    case 'history':
      return 'NAV_COMMIT';
    case 'domReady':
      return 'DOM_READY';
    case 'completed':
      return 'LOAD';
  }
}

function requestKind(type: RawRequestEvent['type']): EventKind {
  switch (type) {
    case 'start':
      return 'REQUEST_START';
    case 'complete':
      return 'REQUEST_COMPLETE';
    case 'error':
      return 'REQUEST_ERROR';
  }
}

/**
 * Hash a Chrome requestId to a positive int for OpaqueRef `request:r${number}`.
 * Never embed the raw chrome requestId string in refs.
 */
export function stablePositiveIntFromRequestId(requestId: string): number {
  let h = 2166136261;
  for (let i = 0; i < requestId.length; i++) {
    h ^= requestId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const positive = h >>> 0;
  return positive === 0 ? 1 : positive;
}

function requestRef(requestId: string): OpaqueRef | undefined {
  if (!requestId) return undefined;
  return `request:r${stablePositiveIntFromRequestId(requestId)}`;
}

function coarseUrlFeatures(url: string): Record<string, string | number | boolean | null> {
  const norm = normalizeUrlForTelemetry(url);
  return {
    hostname: norm.hostname,
    coarsePath: norm.coarsePath,
    isSecure: norm.isSecure,
  };
}

export class EventNormalizer {
  constructor(private registry: NavigationRegistry) {}

  normalizeNavigation(raw: RawNavigationEvent): EventNode | null {
    const epoch = this.registry.getEpoch(raw.tabId, raw.frameId);
    if (!epoch) return null;
    if (epoch.tabId !== raw.tabId || epoch.frameId !== raw.frameId) return null;
    if (raw.documentId !== undefined && raw.documentId !== epoch.documentId) return null;

    const features: Record<string, string | number | boolean | null> = {
      ...coarseUrlFeatures(raw.url),
      isMainFrame: epoch.isMainFrame,
    };
    if (raw.type === 'history') {
      features.spa = true;
    }

    const confidence = isSyntheticDocumentId(epoch.documentId)
      ? CONFIDENCE_SYNTHETIC_DOCUMENT
      : CONFIDENCE_REAL_DOCUMENT;

    return {
      id: createEventId(),
      kind: navigationKind(raw.type),
      scope: {
        tabId: epoch.tabId,
        navigationEpoch: epoch.navigationEpoch,
        documentId: epoch.documentId,
        frameId: epoch.frameId,
        originHash: hashOrigin(epoch.origin),
      },
      timestamp: timestampFromChrome(raw.timeStamp),
      refs: [],
      features,
      provenance: 'webNavigation',
      observationConfidence: clampConfidence(confidence),
    };
  }

  normalizeRequest(raw: RawRequestEvent): EventNode | null {
    const epoch = this.registry.getEpoch(raw.tabId, raw.frameId);
    if (!epoch) return null;
    if (epoch.tabId !== raw.tabId || epoch.frameId !== raw.frameId) return null;
    if (raw.documentId !== undefined && raw.documentId !== epoch.documentId) return null;

    const features: Record<string, string | number | boolean | null> = {
      ...coarseUrlFeatures(raw.url),
    };
    if (raw.resourceType !== undefined && raw.resourceType.length > 0) {
      features.resourceType = raw.resourceType;
    }
    if (raw.error !== undefined && raw.error.length > 0) {
      features.error = raw.error;
    }

    const refs: OpaqueRef[] = [];
    const opaqueRequest = requestRef(raw.requestId);
    if (opaqueRequest) {
      refs.push(opaqueRequest);
    }

    const confidence = isSyntheticDocumentId(epoch.documentId)
      ? CONFIDENCE_SYNTHETIC_DOCUMENT
      : CONFIDENCE_REAL_DOCUMENT;

    return {
      id: createEventId(),
      kind: requestKind(raw.type),
      scope: {
        tabId: epoch.tabId,
        navigationEpoch: epoch.navigationEpoch,
        documentId: epoch.documentId,
        frameId: epoch.frameId,
        originHash: hashOrigin(epoch.origin),
      },
      timestamp: timestampFromChrome(raw.timeStamp),
      refs,
      features,
      provenance: 'webRequest',
      observationConfidence: clampConfidence(confidence),
    };
  }
}
