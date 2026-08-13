/**
 * Phase 3 M3 — pre-generate at most one ExperimentCandidate per CANDIDATE hypothesis.
 *
 * Maps a mechanism to a single Phase-1 allowlisted intervention variable.
 * Never invents CSS selectors, URLs, or JS. INV-X3: oneVariable always true.
 * INV-X5: never form-submit / purchase / auth / paywall defeat.
 * SERVICE_WORKER_CACHE_PATH and UNKNOWN are skipped (not safely controllable).
 */

import {
  CausalHypothesis,
  EventGraph,
  EventNode,
  OpaqueRef,
} from '../../shared/causal/events';
import { isBenignOutcome } from '../../shared/causal/graph';
import {
  ExperimentCandidate,
  MECHANISM_INTERVENTION_TEMPLATES,
  containsForbiddenToken,
  looksLikeSelectorOrUrl,
  nextExperimentId,
  scoreInformationGain,
  uniqueOpaqueRefs,
  withinBudgetCeilings,
} from '../../shared/causal/experiments';

const SKIPPED_MECHANISMS: ReadonlySet<CausalHypothesis['mechanismClass']> = new Set([
  // A rule added after a request was blocked does not retry that request. Until
  // a bounded document-scoped retry protocol exists, abstention is honest.
  'BLOCKED_RESOURCE_PROBE',
  'UNKNOWN',
  'SERVICE_WORKER_CACHE_PATH',
  'SCRIPT_ORDER_DEPENDENCY',
]);

function graphIsBenignOnly(graph: EventGraph): boolean {
  const outcomes = graph.nodes.filter(
    (n) =>
      n.kind === 'OVERLAY_APPEARED' ||
      n.kind === 'SCROLL_LOCK_ON' ||
      n.kind === 'HEALTH_SNAPSHOT'
  );
  return outcomes.length > 0 && outcomes.every(isBenignOutcome);
}

function nodeById(graph: EventGraph, id: OpaqueRef): EventNode | undefined {
  if (!id.startsWith('event:')) return undefined;
  return graph.nodes.find((n) => n.id === id);
}

function hypothesisTouchesBenign(graph: EventGraph, h: CausalHypothesis): boolean {
  for (const ref of [...h.createdFrom, ...h.causeRefs]) {
    const node = nodeById(graph, ref);
    if (node && isBenignOutcome(node)) return true;
  }
  return false;
}

function collectActionRefs(h: CausalHypothesis, strategyRef: OpaqueRef): OpaqueRef[] {
  const fromHypothesis = [...h.causeRefs, ...h.createdFrom].filter((ref) => {
    if (ref.startsWith('event:')) return false;
    if (!ref.startsWith('element:') && !ref.startsWith('request:') && !ref.startsWith('strategy:') && !ref.startsWith('resource:') && !ref.startsWith('frame:')) {
      return false;
    }
    if (containsForbiddenToken(ref) || looksLikeSelectorOrUrl(ref)) return false;
    return true;
  });
  return uniqueOpaqueRefs([strategyRef, ...fromHypothesis]);
}

function scopeFromGraph(graph: EventGraph): ExperimentCandidate['scope'] {
  const frameIds = new Set<number>();
  for (const n of graph.nodes) {
    frameIds.add(n.scope.frameId);
  }
  if (frameIds.size === 0) frameIds.add(0);
  return {
    tabId: graph.scope.tabId,
    navigationEpoch: graph.scope.navigationEpoch,
    documentId: graph.scope.documentId,
    frameIds: Array.from(frameIds).sort((a, b) => a - b),
  };
}

function pairedBaselineAvailable(graph: EventGraph): boolean {
  return graph.nodes.some((n) => n.kind === 'HEALTH_SNAPSHOT');
}

/**
 * Deterministic experiment generation over a single EventGraph.
 * Does not mutate graph.experiments (those are records of executed runs).
 */
export class ExperimentGenerator {
  generate(graph: EventGraph): ExperimentCandidate[] {
    if (graphIsBenignOnly(graph)) return [];

    const candidates: ExperimentCandidate[] = [];
    const usedIds: string[] = graph.experiments.map((e) => e.id);
    // Repeated trials of the same mechanism in one document are dependent and
    // can be contaminated by the previous rollback/fallback cycle. Allocate at
    // most one intervention per mechanism class per document epoch.
    const triedMechanisms = new Set(
      graph.hypotheses
        .filter((h) => h.updatedByExperiments.length > 0)
        .map((h) => h.mechanismClass)
    );
    const candidateHyps = graph.hypotheses.filter(
      (h) => h.status === 'CANDIDATE' && !triedMechanisms.has(h.mechanismClass)
    );
    const competing = candidateHyps.length;
    const scope = scopeFromGraph(graph);
    const paired = pairedBaselineAvailable(graph);

    for (const h of candidateHyps) {
      if (SKIPPED_MECHANISMS.has(h.mechanismClass)) continue;
      if (hypothesisTouchesBenign(graph, h)) continue;

      const template = MECHANISM_INTERVENTION_TEMPLATES[h.mechanismClass];
      if (!template) continue;
      if (containsForbiddenToken(template.variable)) continue;

      const draft: ExperimentCandidate = {
        id: nextExperimentId(usedIds),
        hypothesisRef: h.id,
        intervention: {
          variable: template.variable,
          actionRefs: collectActionRefs(h, template.strategyRef),
          desiredValue: template.desiredValue,
        },
        scope: { ...scope, frameIds: [...scope.frameIds] },
        expected: {
          informationGain: scoreInformationGain(h.confoundingRisk, competing),
          healthRisk: template.healthRisk,
          privacyRisk: template.privacyRisk,
          rollbackConfidence: template.rollbackConfidence,
          durationMs: template.durationMs,
        },
        controls: {
          oneVariable: true,
          requiresReload: false,
          pairedBaselineAvailable: paired,
        },
        rollbackPlanRef: `rollback:${template.variable}`,
      };

      if (!draft.controls.oneVariable) continue;
      if (!withinBudgetCeilings(draft, graph.budgets)) continue;
      if (draft.intervention.actionRefs.length === 0) continue;

      candidates.push(draft);
      usedIds.push(draft.id);
    }

    return candidates;
  }
}
