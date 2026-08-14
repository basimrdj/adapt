import { hashOrigin } from '../../shared/causal/events';
import {
  DestinationClass,
  NavigationTargetObservation,
  UserIntentEnvelope,
} from '../../shared/types';

interface StoredIntent {
  tabId: number;
  frameId: number;
  documentId: string;
  envelope: UserIntentEnvelope;
}

interface NavigationTargetInput {
  sourceTabId: number;
  sourceFrameId: number;
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

  record(tabId: number, frameId: number, documentId: string, envelope: UserIntentEnvelope): void {
    const cutoff = Date.now() - 2500;
    while (this.intents[0] && this.intents[0].envelope.capturedWallMs < cutoff) this.intents.shift();
    this.intents.push({ tabId, frameId, documentId, envelope });
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
    const risks: string[] = [];
    if (!recent) risks.push('NO_RECENT_INTENT');
    if (destination === 'cross-origin') risks.push('CROSS_ORIGIN_TARGET');
    if (input.redirectCount && input.redirectCount > 1) risks.push('REDIRECT_CHAIN');
    if (input.foregroundState === 'background') risks.push('BACKGROUND_TARGET');
    if (recent && !recent.item.envelope.navigationReasonablyExpected) risks.push('UNEXPECTED_AFTER_GESTURE');
    if (recent && recent.item.envelope.elementRole === 'media-control') risks.push('MEDIA_GESTURE_TARGET');

    const declaredDestination = recent?.item.envelope.declaredDestinationClass;
    const destinationMatch = Boolean(recent && (
      declaredDestination === destination
      || declaredDestination === 'cross-origin' && destination === 'cross-origin'
    ));
    const expectedNewContext = Boolean(recent?.item.envelope.newContextReasonablyExpected);
    if (recent && !expectedNewContext) risks.push('EXTRA_TARGET');
    if (recent && !expectedNewContext && destination === 'cross-origin') risks.push('DESTINATION_MISMATCH');
    if (recent && expectedNewContext && destinationMatch) risks.push('EXPECTED_NEW_CONTEXT');
    if (recent && expectedNewContext && !destinationMatch) risks.push('DESTINATION_MISMATCH');
    if (recent?.item.envelope.eventTrusted === false) risks.push('UNTRUSTED_GESTURE');

    const sequenceKey = recent?.item.envelope.ref ?? `orphan:${input.sourceTabId}:${input.sourceFrameId}`;
    const targetCreationSequence = (this.targetSequences.get(sequenceKey) ?? 0) + 1;
    this.targetSequences.set(sequenceKey, targetCreationSequence);

    return {
      ref: stableNavigationRef(input.targetTabId, now),
      sourceTabId: input.sourceTabId,
      sourceFrameId: input.sourceFrameId,
      targetTabId: input.targetTabId,
      capturedWallMs: now,
      sourceOriginHash: sourceHash,
      destinationOriginHash,
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
      intendedNavigationSucceeded: false,
      extraTarget: Boolean(recent && !expectedNewContext),
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
    const declared = recent.item.envelope.declaredDestinationClass;
    const matches = declared === destination || declared === 'cross-origin' && destination === 'cross-origin';
    if (matches || recent.item.envelope.navigationReasonablyExpected) {
      recent.item.envelope = { ...recent.item.envelope, navigationReasonablyExpected: true };
    }
  }

  clearTab(tabId: number): void {
    for (let index = this.intents.length - 1; index >= 0; index--) {
      if (this.intents[index]?.tabId === tabId) this.intents.splice(index, 1);
    }
    for (const key of this.targetSequences.keys()) {
      if (key.includes(`:${tabId}:`)) this.targetSequences.delete(key);
    }
  }
}

export type { NavigationTargetInput };
