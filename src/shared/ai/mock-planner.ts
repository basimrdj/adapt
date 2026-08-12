import { AdaptivePlanner } from './planner-interface';
import { EvidencePacket, AdaptationPlan, PlannedActionProposal } from './types';

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

    const available = new Set(evidence.availableActions);

    // High anti-block reaction evaluation
    if (evidence.currentHealth.antiBlockReaction >= 0.5) {
      // 1. Bait Detector
      const baitElem = evidence.candidateElements.find(
        (e) =>
          e.role.includes('bait') ||
          e.textSignals.some((s) => s.toLowerCase().includes('bait'))
      );
      if (baitElem) {
        return {
          schemaVersion: 1,
          decision: 'ADAPT',
          hypothesis: {
            category: 'BAIT_DETECTOR',
            confidence: 0.95,
            explanation: 'Detected layout bait element triggering anti-adblock detection.',
          },
          selectedStrategyTier: 'S2',
          actions: [{ actionType: 'DOM_PRESERVE_BAIT', targetRef: baitElem.ref, parameter: '' }],
          verification: {
            expectedHealthDelta: 0.25,
            maxWaitMs: 1500,
          },
          abortConditions: [],
          explanationCodes: ['PRESERVE_BAIT_GEOMETRY'],
        };
      }

      // 2. Fullscreen Gate, Blur Gate, Modal Gate, Blocked Probe Gate
      const gateElem = evidence.candidateElements.find(
        (e) =>
          e.role.includes('overlay') ||
          e.role.includes('blur') ||
          e.role.includes('gate') ||
          e.role.includes('dialog') ||
          e.viewportCoverage > 0.5
      );

      if (gateElem || evidence.candidateElements.length > 0) {
        const targetRef = gateElem ? gateElem.ref : evidence.candidateElements[0]?.ref || '';
        const actions: PlannedActionProposal[] = [];

        if (available.has('DOM_REMOVE_OVERLAY')) {
          actions.push({ actionType: 'DOM_REMOVE_OVERLAY', targetRef, parameter: '' });
        }
        if (available.has('DOM_RESTORE_SCROLL')) {
          actions.push({ actionType: 'DOM_RESTORE_SCROLL', targetRef: '', parameter: '' });
        }
        if (available.has('DOM_RESTORE_POINTER_EVENTS')) {
          actions.push({ actionType: 'DOM_RESTORE_POINTER_EVENTS', targetRef: '', parameter: '' });
        }

        if (actions.length === 0 && available.has('ABSTAIN')) {
          actions.push({ actionType: 'ABSTAIN', targetRef: '', parameter: '' });
        }

        return {
          schemaVersion: 1,
          decision: 'ADAPT',
          hypothesis: {
            category: 'FULLSCREEN_GATE',
            confidence: 0.95,
            explanation: 'Detected anti-adblock blocking interstitial gate.',
          },
          selectedStrategyTier: 'S3',
          actions,
          verification: {
            expectedHealthDelta: 0.3,
            maxWaitMs: 1500,
          },
          abortConditions: ['CONTENT_REGRESSION_OBSERVED'],
          explanationCodes: ['REMOVE_BLOCKING_INTERSTITIAL'],
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
