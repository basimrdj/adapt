/**
 * Phase 3 M2 — deterministic candidate hypotheses. No AI.
 *
 * A hypothesis is created only when ALL of:
 * 1. cause precedes outcome within the calibrated lag window (same clock domain)
 * 2. mechanism is controllable/reversible by a Phase-1 allowlisted strategy
 * 3. outcome is not a known benign modal/login/consent class
 * 4. page health drop exceeds the minimum (HEALTH_SNAPSHOT delta, or overlay/scroll-lock proxy)
 * 5. events belong to the same document epoch
 * 6. observationConfidence >= 0.5 and provenance is not labCDP unless the fixture marks it
 *
 * Temporal-only prior is conservative 0.3; posterior = prior until M5.
 * Edges created here are TEMPORAL_CANDIDATE, not proof.
 */

import {
  CausalHypothesis,
  EventEdge,
  EventGraph,
  EventNode,
  OpaqueRef,
  causalKeyFromNode,
  scopesEqual,
} from '../../shared/causal/events';
import {
  DEFAULT_LAG_WINDOWS,
  LagWindow,
  addEdge,
  isBenignOutcome,
  withinLagWindow,
} from '../../shared/causal/graph';

export const MAX_ACTIVE_HYPOTHESES = 8;
export const TEMPORAL_CANDIDATE_PRIOR = 0.3;
export const MIN_OBSERVATION_CONFIDENCE = 0.5;

/** Phase 1 strategies that can actually act on a mechanism class. */
export type Phase1StrategyClass =
  | 'NETWORK'
  | 'DOM_OVERLAY'
  | 'RESTORE_SCROLL'
  | 'PRESERVE_BAIT';

export const MECHANISM_STRATEGY_ALLOWLIST: {
  readonly [K in CausalHypothesis['mechanismClass']]?: Phase1StrategyClass;
} = {
  BLOCKED_RESOURCE_PROBE: 'NETWORK',
  OVERLAY_REINSERTION: 'DOM_OVERLAY',
  SCROLL_LOCK_REACTION: 'RESTORE_SCROLL',
  BAIT_VISIBILITY_PROBE: 'PRESERVE_BAIT',
  COSMETIC_REMOVAL_DEPENDENCY: 'DOM_OVERLAY',
  SERVICE_WORKER_CACHE_PATH: 'NETWORK',
};

type MechanismClass = CausalHypothesis['mechanismClass'];
type HypothesisOutcome = CausalHypothesis['outcome'];

interface CandidateRule {
  window: LagWindow;
  mechanismClass: MechanismClass;
  outcome: HypothesisOutcome;
  confoundingRisk: CausalHypothesis['confoundingRisk'];
  matchCause: (node: EventNode) => boolean;
  matchOutcome: (node: EventNode) => boolean;
}

function numberFeature(node: EventNode, key: string): number | null {
  const v = node.features[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isBlockedRequest(node: EventNode): boolean {
  if (node.kind === 'REQUEST_ERROR') return true;
  if (node.kind === 'REQUEST_START' || node.kind === 'REQUEST_COMPLETE') {
    if (node.features.blocked === true) return true;
    const err = node.features.error;
    return typeof err === 'string' && err.length > 0;
  }
  return false;
}

function isScriptComplete(node: EventNode): boolean {
  return node.kind === 'REQUEST_COMPLETE' && node.features.resourceType === 'script';
}

function isServiceWorkerOrCache(node: EventNode): boolean {
  return (
    node.features.serviceWorker === true ||
    node.features.cacheHit === true ||
    node.features.fromCache === true
  );
}

function healthDelta(node: EventNode): number | null {
  return numberFeature(node, 'delta') ?? numberFeature(node, 'healthDelta');
}

/**
 * Overlay / scroll-lock are proxies for a health drop. HEALTH_SNAPSHOT needs a
 * negative compact delta. Content-mismatch kinds count for the SW/cache window.
 */
export function hasHealthDrop(node: EventNode): boolean {
  if (node.kind === 'OVERLAY_APPEARED' || node.kind === 'SCROLL_LOCK_ON') return true;
  if (node.kind === 'CONTENT_VISIBILITY_CHANGED' || node.kind === 'CONTENT_HEIGHT_CHANGED') {
    return true;
  }
  if (node.kind === 'HEALTH_SNAPSHOT') {
    const delta = healthDelta(node);
    return delta !== null && delta < 0;
  }
  return false;
}

function observationEligible(node: EventNode): boolean {
  if (node.observationConfidence < MIN_OBSERVATION_CONFIDENCE) return false;
  if (node.provenance === 'labCDP' && node.features.labFixture !== true) return false;
  return true;
}

function isControllable(mechanism: MechanismClass): boolean {
  if (mechanism === 'UNKNOWN') return true;
  return MECHANISM_STRATEGY_ALLOWLIST[mechanism] !== undefined;
}

function recipeMechanism(cause: EventNode, outcome: EventNode): MechanismClass {
  if (cause.features.cosmetic === true || outcome.features.cosmetic === true) {
    return 'COSMETIC_REMOVAL_DEPENDENCY';
  }
  const hint = cause.features.mechanismClass ?? outcome.features.mechanismClass;
  if (hint === 'COSMETIC_REMOVAL_DEPENDENCY') return 'COSMETIC_REMOVAL_DEPENDENCY';
  return 'UNKNOWN';
}

const STATIC_RULES: CandidateRule[] = [
  {
    window: DEFAULT_LAG_WINDOWS.blockedRequestToAntiBlockOverlay,
    mechanismClass: 'BLOCKED_RESOURCE_PROBE',
    outcome: 'ANTI_BLOCK_REACTION',
    confoundingRisk: 'MEDIUM',
    matchCause: isBlockedRequest,
    matchOutcome: (n) => n.kind === 'OVERLAY_APPEARED',
  },
  {
    window: DEFAULT_LAG_WINDOWS.baitStateChangeToReactionUi,
    mechanismClass: 'BAIT_VISIBILITY_PROBE',
    outcome: 'ANTI_BLOCK_REACTION',
    confoundingRisk: 'MEDIUM',
    matchCause: (n) => n.kind === 'BAIT_STATE_CHANGED',
    matchOutcome: (n) => n.kind === 'OVERLAY_APPEARED',
  },
  {
    window: DEFAULT_LAG_WINDOWS.domRemovalToReinsertion,
    mechanismClass: 'OVERLAY_REINSERTION',
    outcome: 'ANTI_BLOCK_REACTION',
    confoundingRisk: 'MEDIUM',
    matchCause: (n) => n.kind === 'OVERLAY_REMOVED',
    matchOutcome: (n) => n.kind === 'OVERLAY_APPEARED',
  },
  {
    window: DEFAULT_LAG_WINDOWS.scriptCompleteToScrollLock,
    mechanismClass: 'SCROLL_LOCK_REACTION',
    outcome: 'PAGE_BREAKAGE',
    confoundingRisk: 'MEDIUM',
    matchCause: isScriptComplete,
    matchOutcome: (n) => n.kind === 'SCROLL_LOCK_ON',
  },
  {
    window: DEFAULT_LAG_WINDOWS.serviceWorkerCacheToContentMismatch,
    mechanismClass: 'SERVICE_WORKER_CACHE_PATH',
    outcome: 'PAGE_BREAKAGE',
    confoundingRisk: 'HIGH',
    matchCause: isServiceWorkerOrCache,
    matchOutcome: (n) =>
      n.kind === 'CONTENT_VISIBILITY_CHANGED' ||
      n.kind === 'CONTENT_HEIGHT_CHANGED' ||
      n.kind === 'HEALTH_SNAPSHOT',
  },
];

function uniqueRefs(refs: OpaqueRef[]): OpaqueRef[] {
  const seen = new Set<OpaqueRef>();
  const out: OpaqueRef[] = [];
  for (const r of refs) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

function mergeKey(mechanism: MechanismClass, causeRefs: OpaqueRef[]): string {
  return `${mechanism}|${[...causeRefs].sort().join(',')}`;
}

function nextHypothesisId(existing: CausalHypothesis[]): `hypothesis:h${number}` {
  let max = 0;
  for (const h of existing) {
    const n = Number(h.id.slice('hypothesis:h'.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `hypothesis:h${max + 1}`;
}

function sameDocumentEpoch(a: EventNode, b: EventNode): boolean {
  return scopesEqual(causalKeyFromNode(a), causalKeyFromNode(b));
}

function pairEligible(cause: EventNode, outcome: EventNode, window: LagWindow): boolean {
  if (cause.id === outcome.id) return false;
  if (!sameDocumentEpoch(cause, outcome)) return false;
  if (!observationEligible(cause) || !observationEligible(outcome)) return false;
  if (isBenignOutcome(outcome) || isBenignOutcome(cause)) return false;
  if (!hasHealthDrop(outcome)) return false;
  if (!withinLagWindow(cause, outcome, window)) return false;
  return true;
}

function temporalEdge(cause: EventNode, outcome: EventNode, window: LagWindow): EventEdge {
  return {
    id: `edge:${cause.id}:${outcome.id}:TRIGGERS_REACTION`,
    from: cause.id,
    to: outcome.id,
    relation: 'TRIGGERS_REACTION',
    lagMs: { min: window.min, max: window.max },
    status: 'TEMPORAL_CANDIDATE',
    support: {
      observationalN: 1,
      interventionN: 0,
      positiveN: 0,
      negativeN: 0,
    },
    confounders: [],
    lastUpdatedWallMs: Date.now(),
  };
}

interface Draft {
  mechanismClass: MechanismClass;
  outcome: HypothesisOutcome;
  confoundingRisk: CausalHypothesis['confoundingRisk'];
  causeRefs: OpaqueRef[];
  createdFrom: OpaqueRef[];
  window: LagWindow;
  cause: EventNode;
  outcomeNode: EventNode;
}

function collectDrafts(nodes: EventNode[]): Draft[] {
  const drafts: Draft[] = [];

  for (const rule of STATIC_RULES) {
    if (!isControllable(rule.mechanismClass)) continue;
    for (const cause of nodes) {
      if (!rule.matchCause(cause)) continue;
      for (const outcome of nodes) {
        if (!rule.matchOutcome(outcome)) continue;
        if (!pairEligible(cause, outcome, rule.window)) continue;
        drafts.push({
          mechanismClass: rule.mechanismClass,
          outcome: rule.outcome,
          confoundingRisk: rule.confoundingRisk,
          causeRefs: uniqueRefs([cause.id, ...cause.refs, ...outcome.refs]),
          createdFrom: uniqueRefs([cause.id, outcome.id]),
          window: rule.window,
          cause,
          outcomeNode: outcome,
        });
      }
    }
  }

  const recipeWindow = DEFAULT_LAG_WINDOWS.recipeReplayToHealthDeterioration;
  for (const cause of nodes) {
    if (cause.kind !== 'RECIPE_REPLAY') continue;
    for (const outcome of nodes) {
      if (outcome.kind !== 'HEALTH_SNAPSHOT') continue;
      if (!pairEligible(cause, outcome, recipeWindow)) continue;
      const mechanism = recipeMechanism(cause, outcome);
      if (!isControllable(mechanism)) continue;
      drafts.push({
        mechanismClass: mechanism,
        outcome: 'PAGE_BREAKAGE',
        confoundingRisk: 'MEDIUM',
        causeRefs: uniqueRefs([cause.id, ...cause.refs]),
        createdFrom: uniqueRefs([cause.id, outcome.id]),
        window: recipeWindow,
        cause,
        outcomeNode: outcome,
      });
    }
  }

  return drafts;
}

function mergeDrafts(drafts: Draft[]): Draft[] {
  const byKey = new Map<string, Draft>();
  for (const d of drafts) {
    const key = mergeKey(d.mechanismClass, d.causeRefs);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, d);
      continue;
    }
    existing.createdFrom = uniqueRefs([...existing.createdFrom, ...d.createdFrom]);
  }
  return Array.from(byKey.values());
}

/**
 * Deterministic candidate generation over a single EventGraph.
 * Mutates graph.hypotheses (CANDIDATE slots) and appends TEMPORAL_CANDIDATE edges.
 */
export class CandidateGenerator {
  update(graph: EventGraph): CausalHypothesis[] {
    const preserved = graph.hypotheses.filter((h) => h.status !== 'CANDIDATE');
    const drafts = mergeDrafts(collectDrafts(graph.nodes));
    const activePreserved = preserved.filter((h) => h.status !== 'REFUTED').length;
    const room = Math.max(0, MAX_ACTIVE_HYPOTHESES - activePreserved);
    const capped = drafts.slice(0, room);

    const generated: CausalHypothesis[] = [];
    let allocated = preserved;
    for (const d of capped) {
      const id = nextHypothesisId(allocated);
      const hypothesis: CausalHypothesis = {
        id,
        causeRefs: d.causeRefs,
        outcome: d.outcome,
        mechanismClass: d.mechanismClass,
        prior: TEMPORAL_CANDIDATE_PRIOR,
        posterior: TEMPORAL_CANDIDATE_PRIOR,
        confoundingRisk: d.confoundingRisk,
        status: 'CANDIDATE',
        createdFrom: d.createdFrom,
        updatedByExperiments: [],
      };
      generated.push(hypothesis);
      allocated = [...allocated, hypothesis];
      addEdge(graph, temporalEdge(d.cause, d.outcomeNode, d.window));
    }

    graph.hypotheses = [...preserved, ...generated];
    return graph.hypotheses;
  }
}
