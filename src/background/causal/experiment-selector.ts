/**
 * Phase 3 M3 — safest informative experiment (spec §14).
 *
 * Hard feasibility filter FIRST, then maximize
 *   U(x) = IG - λh*HealthRisk - λp*PrivacyRisk - λt*NormalizedDuration - λr*(1-RollbackConfidence)
 *
 * A very informative unsafe experiment is NOT selectable. None feasible → null (abstain).
 */

import {
  CurrentEpochState,
  ExperimentCandidate,
  ExperimentSelectionBudget,
  experimentUtility,
  isEpochFresh,
  isPolicyAllowed,
} from '../../shared/causal/experiments';

export { experimentUtility } from '../../shared/causal/experiments';

function passesHardFilter(
  x: ExperimentCandidate,
  now: CurrentEpochState,
  budget: ExperimentSelectionBudget
): boolean {
  if (!isPolicyAllowed(x)) return false;
  if (!isEpochFresh(x.scope, now)) return false;
  if (x.expected.privacyRisk > budget.maxPrivacyRisk) return false;
  if (x.expected.healthRisk > budget.maxHealthRisk) return false;
  if (x.expected.rollbackConfidence < budget.minRollbackConfidence) return false;
  if (budget.remaining <= 0) return false;
  if (!x.controls.oneVariable) return false;
  return true;
}

function compareUtility(a: ExperimentCandidate, b: ExperimentCandidate): number {
  const ua = experimentUtility(a);
  const ub = experimentUtility(b);
  if (ub !== ua) return ub - ua;
  if (a.expected.privacyRisk !== b.expected.privacyRisk) {
    return a.expected.privacyRisk - b.expected.privacyRisk;
  }
  if (a.expected.healthRisk !== b.expected.healthRisk) {
    return a.expected.healthRisk - b.expected.healthRisk;
  }
  if (a.expected.durationMs !== b.expected.durationMs) {
    return a.expected.durationMs - b.expected.durationMs;
  }
  return a.id.localeCompare(b.id);
}

export class ExperimentSelector {
  /**
   * Returns the maximum-utility feasible candidate, or null to abstain.
   */
  select(
    candidates: readonly ExperimentCandidate[],
    now: CurrentEpochState,
    budget: ExperimentSelectionBudget
  ): ExperimentCandidate | null {
    const feasible = candidates.filter((x) => passesHardFilter(x, now, budget));
    if (feasible.length === 0) return null;
    const ranked = [...feasible].sort(compareUtility);
    return ranked[0] ?? null;
  }
}

export function selectExperiment(
  candidates: readonly ExperimentCandidate[],
  now: CurrentEpochState,
  budget: ExperimentSelectionBudget
): ExperimentCandidate | null {
  return new ExperimentSelector().select(candidates, now, budget);
}
