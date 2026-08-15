import { hashOrigin } from '../../shared/causal/events';
import {
  DestinationClass,
  NavigationTargetObservation,
  UserIntentEnvelope,
} from '../../shared/types';
import { DestinationFingerprintMatch, IntentOutcomeTracker, destinationFingerprint } from './intent-outcome';

interface StoredIntent {
  tabId: number;
  frameId: number;
  documentId: string;
  envelope: UserIntentEnvelope;
}

interface NavigationTargetInput {
  sourceTabId: number;
  sourceFrameId: number;
  sourceDocumentId?: string;
  targetTabId: number;
  url: string;
  timeStamp?: number;
  sourceOrigin?: string;
  openerRelationship?: 'explicit' | 'implicit' | 'unknown';
  foregroundState?: 'foreground' | 'background' | 'unknown';
  redirectCount?: number;
}

function destinationClass(url: string, sourceOrigin: string): DestinationClass {
  try {
    const parsed = new URL(url);
    if (parsed.origin === sourceOrigin) return 'same-origin';
    if (/oauth|authorize|signin|login/i.test(parsed.pathname)) return 'oauth-like';
    if (/pay|checkout|billing|purchase/i.test(parsed.pathname)) return 'payment-like';
    if (/\.pdf$|\.docx?$|\.xlsx?$|\.zip$/i.test(parsed.pathname)) return 'document';
    return 'cross-origin';
  } catch {
    return 'unknown';
  }
}

function destinationPathClass(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0] ?? 'root';
  } catch {
    return 'unknown';
  }
}

function stableNavigationRef(targetTabId: number, timestamp: number): `navigation:n${number}` {
  const raw = `${targetTabId}:${timestamp}`;
  let value = 2166136261;
  for (let index = 0; index < raw.length; index++) {
    value ^= raw.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return `navigation:n${(value >>> 0) || 1}`;
}

export class IntentTracker {
  private readonly intents: StoredIntent[] = [];
  private readonly targetSequences = new Map<string, number>();
  private readonly outcomes = new IntentOutcomeTracker();

  record(tabId: number, frameId: number, documentId: string, envelope: UserIntentEnvelope): void {
    const cutoff = Date.now() - 2500;
    while (this.intents[0] && this.intents[0].envelope.capturedWallMs < cutoff) this.intents.shift();
    this.intents.push({ tabId, frameId, documentId, envelope });
    this.outcomes.begin(tabId, frameId, documentId, envelope);
    while (this.intents.length > 64) this.intents.shift();
  }

  correlate(input: NavigationTargetInput): NavigationTargetObservation {
    const now = input.timeStamp ?? Date.now();
    const sourceOrigin = input.sourceOrigin ?? '';
    const candidates = this.intents
      .filter((item) => item.tabId === input.sourceTabId && item.frameId === input.sourceFrameId)
      .map((item) => ({ item, age: Math.max(0, now - item.envelope.capturedWallMs) }))
      .filter((item) => item.age <= 1500)
      .sort((a, b) => a.age - b.age);
    const recent = candidates[0];
    const destination = destinationClass(input.url, sourceOrigin);
    const sourceHash = hashOrigin(sourceOrigin || 'unknown');
    const destinationOriginHash = (() => {
      try { return hashOrigin(new URL(input.url).origin); } catch { return hashOrigin('unknown'); }
    })();
    const destinationFp = destinationFingerprint(destinationOriginHash, destination, destinationPathClass(input.url));
    const risks: string[] = [];
    if (!recent) risks.push('NO_RECENT_INTENT');
    if (destination === 'cross-origin') risks.push('CROSS_ORIGIN_TARGET');
    if (input.redirectCount && input.redirectCount > 1) risks.push('REDIRECT_CHAIN');
    if (input.foregroundState === 'background') risks.push('BACKGROUND_TARGET');
    if (recent && !recent.item.envelope.navigationReasonablyExpected) risks.push('UNEXPECTED_AFTER_GESTURE');
    if (recent && recent.item.envelope.elementRole === 'media-control') risks.push('MEDIA_GESTURE_TARGET');

    const declaredDestination = recent?.item.envelope.declaredDestinationClass;
    const destinationFingerprintMatch: DestinationFingerprintMatch = !recent
      ? 'UNKNOWN'
      : recent.item.envelope.declaredDestinationFingerprint
        ? recent.item.envelope.declaredDestinationFingerprint === destinationFp ? 'MATCH' : 'MISMATCH'
        : declaredDestination === destination || declaredDestination === 'cross-origin' && destination === 'cross-origin'
          ? 'MATCH'
          : 'UNKNOWN';
    const destinationMatch = destinationFingerprintMatch === 'MATCH';
    const expectedNewContext = Boolean(recent?.item.envelope.newContextReasonablyExpected);
    const outcome = this.outcomes.observeNewContextTarget(recent?.item.envelope.ref, stableNavigationRef(input.targetTabId, now), expectedNewContext, destinationFingerprintMatch);
    const extraTarget = Boolean(recent && outcome.extraTarget);
    if (extraTarget) risks.push('EXTRA_TARGET');
    if (recent && destinationFingerprintMatch === 'MISMATCH') risks.push('DESTINATION_MISMATCH');
    if (recent && expectedNewContext && destinationMatch && !extraTarget) risks.push('EXPECTED_NEW_CONTEXT');
    if (recent?.item.envelope.eventTrusted === false) risks.push('UNTRUSTED_GESTURE');

    const sequenceKey = recent?.item.envelope.ref ?? `orphan:${input.sourceTabId}:${input.sourceFrameId}`;
    const targetCreationSequence = (this.targetSequences.get(sequenceKey) ?? 0) + 1;
    this.targetSequences.set(sequenceKey, targetCreationSequence);

    return {
      ref: stableNavigationRef(input.targetTabId, now),
      sourceTabId: input.sourceTabId,
      sourceFrameId: input.sourceFrameId,
      sourceDocumentId: recent?.item.documentId ?? input.sourceDocumentId,
      targetTabId: input.targetTabId,
      capturedWallMs: now,
      sourceOriginHash: sourceHash,
      destinationOriginHash,
      destinationFingerprint: destinationFp,
      destinationClass: destination,
      redirectCount: input.redirectCount ?? 0,
      foregroundState: input.foregroundState ?? 'unknown',
      openerRelationship: input.openerRelationship ?? (recent ? 'implicit' : 'unknown'),
      recentIntentRef: recent?.item.envelope.ref,
      recentIntentAgeMs: recent?.age,
      riskSignals: risks,
      declaredDestinationClass: declaredDestination,
      navigationReasonablyExpected: recent?.item.envelope.navigationReasonablyExpected,
      targetCreationSequence,
      destinationMatch,
      destinationFingerprintMatch,
      expectedNewContextCount: outcome.expectedCount,
      observedNewContextCount: outcome.observedCount,
      intendedNavigationSucceeded: false,
      extraTarget,
      expectedNewContext,
    };
  }

  observeNavigationCommitted(tabId: number, frameId: number, url: string, timeStamp?: number, sourceOrigin?: string): void {
    const now = timeStamp ?? Date.now();
    const recent = this.intents
      .filter((item) => item.tabId === tabId && item.frameId === frameId)
      .map((item) => ({ item, age: Math.max(0, now - item.envelope.capturedWallMs) }))
      .filter((item) => item.age <= 2500)
      .sort((a, b) => a.age - b.age)[0];
    if (!recent) return;
    const destination = destinationClass(url, sourceOrigin ?? '');
    const destinationOriginHash = (() => {
      try { return hashOrigin(new URL(url).origin); } catch { return hashOrigin('unknown'); }
    })();
    const fp = destinationFingerprint(destinationOriginHash, destination, destinationPathClass(url));
    const declared = recent.item.envelope.declaredDestinationClass;
    const matches = recent.item.envelope.declaredDestinationFingerprint
      ? recent.item.envelope.declaredDestinationFingerprint === fp
      : declared === destination || declared === 'cross-origin' && destination === 'cross-origin';
    const match: DestinationFingerprintMatch = recent.item.envelope.declaredDestinationFingerprint
      ? matches ? 'MATCH' : 'MISMATCH'
      : matches ? 'MATCH' : 'UNKNOWN';
    this.outcomes.observeSameTabNavigation(recent.item.envelope.ref, match);
    if (matches || recent.item.envelope.navigationReasonablyExpected) {
      recent.item.envelope = { ...recent.item.envelope, navigationReasonablyExpected: true };
    }
  }

  hasRecentIntent(tabId: number, frameId: number, timeStamp = Date.now()): boolean {
    return this.intents.some((item) =>
      item.tabId === tabId
      && item.frameId === frameId
      && Math.max(0, timeStamp - item.envelope.capturedWallMs) <= 2500
    );
  }

  clearTab(tabId: number): void {
    for (let index = this.intents.length - 1; index >= 0; index--) {
      if (this.intents[index]?.tabId === tabId) this.intents.splice(index, 1);
    }
    for (const key of this.targetSequences.keys()) {
      if (key.includes(`:${tabId}:`)) this.targetSequences.delete(key);
    }
    this.outcomes.clearTab(tabId);
  }
}

export type { NavigationTargetInput };
