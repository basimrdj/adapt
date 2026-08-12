import { EvidencePacket, AdaptationPlan, PolicyValidationResult } from './types';
import { StrategyAction } from '../types';

export class PolicyValidator {
  /**
   * Strictly validates an AI proposed AdaptationPlan against the EvidencePacket
   * and maps approved proposals to Phase 1 StrategyAction primitives.
   */
  public validate(evidence: EvidencePacket, rawPlan: unknown): PolicyValidationResult {
    const reasons: string[] = [];

    if (!rawPlan || typeof rawPlan !== 'object') {
      return { valid: false, reasons: ['Plan is null or non-object'] };
    }

    const plan = rawPlan as AdaptationPlan;

    // 1. Validate Schema Version & Decision
    if (plan.schemaVersion !== 1) {
      reasons.push(`Unsupported schemaVersion: ${plan.schemaVersion}`);
    }

    if (!['ADAPT', 'OBSERVE', 'ABSTAIN'].includes(plan.decision)) {
      reasons.push(`Invalid decision: ${plan.decision}`);
    }

    // 2. Validate Hypothesis & Confidence
    if (
      !plan.hypothesis ||
      typeof plan.hypothesis.confidence !== 'number' ||
      !Number.isFinite(plan.hypothesis.confidence)
    ) {
      reasons.push('Missing or invalid hypothesis.confidence');
    } else if (plan.hypothesis.confidence < 0 || plan.hypothesis.confidence > 1.0) {
      reasons.push(`Confidence out of bounds [0, 1]: ${plan.hypothesis.confidence}`);
    }

    // 3. Validate Actions & Opaque Reference Matching
    if (!Array.isArray(plan.actions)) {
      reasons.push('Plan.actions is not an array');
    } else {
      const validElementRefs = new Set(evidence.candidateElements.map((e) => e.ref));
      const validRequestRefs = new Set(evidence.candidateRequests.map((r) => r.ref));
      const allowedActions = new Set(evidence.availableActions);

      for (let i = 0; i < plan.actions.length; i++) {
        const act = plan.actions[i];
        if (!act) continue;
        if (!allowedActions.has(act.actionType)) {
          reasons.push(`Action ${act.actionType} is not in availableActions`);
        }

        // If targetRef is provided, it MUST exist in the evidence packet
        if (act.targetRef && act.targetRef.length > 0) {
          const isElement = act.targetRef.startsWith('element:');
          const isRequest = act.targetRef.startsWith('request:');

          if (isElement && !validElementRefs.has(act.targetRef)) {
            reasons.push(`Action [${i}] references non-existent element: ${act.targetRef}`);
          } else if (isRequest && !validRequestRefs.has(act.targetRef)) {
            reasons.push(`Action [${i}] references non-existent request: ${act.targetRef}`);
          } else if (!isElement && !isRequest) {
            reasons.push(`Action [${i}] has invalid targetRef format: ${act.targetRef}`);
          }
        }
      }
    }

    // 4. Validate Verification parameters
    if (
      !plan.verification ||
      typeof plan.verification.maxWaitMs !== 'number' ||
      !Number.isFinite(plan.verification.maxWaitMs) ||
      plan.verification.maxWaitMs < 0 ||
      plan.verification.maxWaitMs > 10000
    ) {
      reasons.push('Invalid verification.maxWaitMs (must be 0-10000ms finite number)');
    }

    if (
      plan.verification &&
      (typeof plan.verification.expectedHealthDelta !== 'number' ||
        !Number.isFinite(plan.verification.expectedHealthDelta))
    ) {
      reasons.push('Invalid verification.expectedHealthDelta (must be finite number)');
    }

    if (reasons.length > 0) {
      return { valid: false, reasons };
    }

    // Map validated proposals to Phase 1 StrategyAction primitives
    const mappedStrategyActions: StrategyAction[] = [];
    if (plan.decision === 'ADAPT') {
      for (const act of plan.actions) {
        switch (act.actionType) {
          case 'DOM_REMOVE_OVERLAY':
            mappedStrategyActions.push({
              id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'DOM_REMOVE_OVERLAY',
            });
            break;
          case 'DOM_RESTORE_SCROLL':
            mappedStrategyActions.push({
              id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'DOM_RESTORE_SCROLL',
            });
            break;
          case 'DOM_RESTORE_POINTER_EVENTS':
            mappedStrategyActions.push({
              id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'DOM_RESTORE_POINTER_EVENTS',
            });
            break;
          case 'DOM_PRESERVE_BAIT':
            mappedStrategyActions.push({
              id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'DOM_PRESERVE_BAIT_CANDIDATE',
            });
            break;
          case 'DOM_HIDE_CANDIDATE':
            mappedStrategyActions.push({
              id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'DOM_COLLAPSE',
            });
            break;
          case 'NET_TEMP_BLOCK':
            if (act.parameter) {
              mappedStrategyActions.push({
                id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                type: 'NET_BLOCK',
                urlFilter: act.parameter,
              });
            }
            break;
        }
      }
    }

    return {
      valid: true,
      reasons: [],
      sanitizedPlan: plan,
      mappedStrategyActions,
    };
  }
}
