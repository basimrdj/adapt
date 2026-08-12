import { AdaptivePlanner } from './planner-interface';
import { EvidencePacket, AdaptationPlan } from './types';

export class MockPlanner implements AdaptivePlanner {
  private predefinedPlans = new Map<string, AdaptationPlan>();

  public setMockPlan(triggerKey: string, plan: AdaptationPlan): void {
    this.predefinedPlans.set(triggerKey, plan);
  }

  public async plan(evidence: EvidencePacket): Promise<AdaptationPlan> {
    const triggerKey = evidence.trigger.reason;
    if (this.predefinedPlans.has(triggerKey)) {
      return this.predefinedPlans.get(triggerKey)!;
    }

    // Default intelligent rule-based mock response
    if (evidence.currentHealth.antiBlockReaction >= 0.5) {
      if (evidence.candidateElements.some((e) => e.role === 'fullscreen-overlay')) {
        const overlayRef = evidence.candidateElements.find((e) => e.role === 'fullscreen-overlay')!.ref;
        return {
          schemaVersion: 1,
          decision: 'ADAPT',
          hypothesis: {
            category: 'FULLSCREEN_GATE',
            confidence: 0.95,
            explanation: 'Detected fullscreen blocking overlay preventing access.',
          },
          selectedStrategyTier: 'S3',
          actions: [
            { actionType: 'DOM_REMOVE_OVERLAY', targetRef: overlayRef, parameter: '' },
            { actionType: 'DOM_RESTORE_SCROLL', targetRef: '', parameter: '' },
            { actionType: 'DOM_RESTORE_POINTER_EVENTS', targetRef: '', parameter: '' },
          ],
          verification: {
            expectedHealthDelta: 0.3,
            maxWaitMs: 1500,
          },
          abortConditions: ['CONTENT_REGRESSION_OBSERVED'],
          explanationCodes: ['REMOVE_BLOCKING_INTERSTITIAL'],
        };
      }

      if (evidence.candidateElements.some((e) => e.textSignals.includes('bait'))) {
        const baitRef = evidence.candidateElements.find((e) => e.textSignals.includes('bait'))!.ref;
        return {
          schemaVersion: 1,
          decision: 'ADAPT',
          hypothesis: {
            category: 'BAIT_DETECTOR',
            confidence: 0.9,
            explanation: 'Detected layout bait element triggering anti-adblock detection.',
          },
          selectedStrategyTier: 'S2',
          actions: [{ actionType: 'DOM_PRESERVE_BAIT', targetRef: baitRef, parameter: '' }],
          verification: {
            expectedHealthDelta: 0.25,
            maxWaitMs: 1500,
          },
          abortConditions: [],
          explanationCodes: ['PRESERVE_BAIT_GEOMETRY'],
        };
      }
    }

    // Benign / Negative control default
    return {
      schemaVersion: 1,
      decision: 'ABSTAIN',
      hypothesis: {
        category: 'BENIGN_CONSENT',
        confidence: 0.9,
        explanation: 'Benign user dialog or insufficient anti-adblock evidence.',
      },
      selectedStrategyTier: 'ABSTAIN',
      actions: [{ actionType: 'ABSTAIN', targetRef: '', parameter: '' }],
      verification: {
        expectedHealthDelta: 0.0,
        maxWaitMs: 500,
      },
      abortConditions: [],
      explanationCodes: ['NO_ADAPTATION_REQUIRED'],
    };
  }
}
