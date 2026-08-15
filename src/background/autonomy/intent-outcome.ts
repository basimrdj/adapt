import { DestinationClass, UserIntentEnvelope } from '../../shared/types';

export type DestinationFingerprintMatch = 'MATCH' | 'MISMATCH' | 'UNKNOWN';

export interface IntentOutcomeState {
  intentRef: UserIntentEnvelope['ref'];
  sourceTabId: number;
  sourceFrameId: number;
  sourceDocumentId: string;
  capturedWallMs: number;
  expectedNavigationMode: UserIntentEnvelope['targetBehavior'];
  declaredDestinationFingerprint?: string;
  expectedNewContextCount: number;
  observedSameTabNavigations: number;
  observedNewContextTargets: string[];
  successfulIntendedOutcomes: number;
  extraOutcomes: string[];
}

export class IntentOutcomeTracker {
  private readonly states = new Map<string, IntentOutcomeState>();

  begin(tabId: number, frameId: number, documentId: string, envelope: UserIntentEnvelope): void {
    this.states.set(envelope.ref, {
      intentRef: envelope.ref,
      sourceTabId: tabId,
      sourceFrameId: frameId,
      sourceDocumentId: documentId,
      capturedWallMs: envelope.capturedWallMs,
      expectedNavigationMode: envelope.targetBehavior,
      declaredDestinationFingerprint: envelope.declaredDestinationFingerprint,
      expectedNewContextCount: envelope.newContextReasonablyExpected ? 1 : 0,
      observedSameTabNavigations: 0,
      observedNewContextTargets: [],
      successfulIntendedOutcomes: 0,
      extraOutcomes: [],
    });
  }

  observeSameTabNavigation(intentRef: string, destinationMatch: DestinationFingerprintMatch): void {
    const state = this.states.get(intentRef);
    if (!state) return;
    state.observedSameTabNavigations += 1;
    if (destinationMatch === 'MATCH' || state.expectedNavigationMode === 'same-context') {
      state.successfulIntendedOutcomes += 1;
    }
  }

  observeNewContextTarget(
    intentRef: string | undefined,
    targetRef: string,
    expectedNewContext: boolean,
    destinationMatch: DestinationFingerprintMatch,
  ): { extraTarget: boolean; observedCount: number; expectedCount: number } {
    if (!intentRef) return { extraTarget: false, observedCount: 0, expectedCount: 0 };
    const state = this.states.get(intentRef);
    if (!state) return { extraTarget: false, observedCount: 0, expectedCount: 0 };
    const extraTarget = expectedNewContext
      ? state.observedNewContextTargets.length >= state.expectedNewContextCount
      : true;
    state.observedNewContextTargets.push(targetRef);
    if (extraTarget || destinationMatch === 'MISMATCH') state.extraOutcomes.push(targetRef);
    if (!extraTarget && destinationMatch === 'MATCH') state.successfulIntendedOutcomes += 1;
    return {
      extraTarget,
      observedCount: state.observedNewContextTargets.length,
      expectedCount: state.expectedNewContextCount,
    };
  }

  get(intentRef: string): IntentOutcomeState | undefined {
    const state = this.states.get(intentRef);
    return state ? { ...state, observedNewContextTargets: [...state.observedNewContextTargets], extraOutcomes: [...state.extraOutcomes] } : undefined;
  }

  clearTab(tabId: number): void {
    for (const [ref, state] of this.states.entries()) {
      if (state.sourceTabId === tabId) this.states.delete(ref);
    }
  }
}

export function destinationFingerprint(
  originHash: string,
  destinationClass: DestinationClass,
  pathClass: string,
): string {
  return `${originHash}:${destinationClass}:${pathClass}`;
}
