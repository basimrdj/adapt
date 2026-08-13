import { describe, it, expect } from 'vitest';
import { BeliefUpdater } from '../../src/background/causal/belief-updater';
import {
  UNIFORM_PRIOR,
  emptyEffectEstimate,
  observedN,
  posteriorMean,
} from '../../src/shared/causal/belief';
import {
  CausalHypothesis,
  EventEdge,
  EventGraph,
  ExperimentRecord,
  HealthVectorCompact,
  OpaqueRef,
} from '../../src/shared/causal/events';
import { DEFAULT_EXPERIMENT_BUDGET, createEmptyGraph } from '../../src/shared/causal/graph';

const KEY = {
  tabId: 1,
  navigationEpoch: 1,
  documentId: 'doc-belief',
  frameId: 0,
};

const ORIGIN_HASH = '100680ad546ce6a577f42f52df33b4cfdca756859e664b8d7de329b150d09ce9';

const HEALTH: HealthVectorCompact = {
  contentAccess: 0.5,
  interaction: 0.5,
  scrollability: 0.5,
  visualObstruction: 0.5,
  mutationStability: 0.5,
  networkIntegrity: 0.5,
  privacyPreservation: 1,
  confidence: 1,
};

function makeHyp(
  id: CausalHypothesis['id'],
  extras?: Partial<CausalHypothesis>
): CausalHypothesis {
  const n = Number(id.slice('hypothesis:h'.length));
  return {
    id,
    causeRefs: [`element:e${n}`],
    outcome: 'ANTI_BLOCK_REACTION',
    mechanismClass: 'OVERLAY_REINSERTION',
    prior: 0.3,
    posterior: 0.3,
    confoundingRisk: 'LOW',
    status: 'CANDIDATE',
    createdFrom: ['event:overlay'],
    updatedByExperiments: [],
    ...extras,
  };
}

function makeRecord(
  id: ExperimentRecord['id'],
  status: ExperimentRecord['status'],
  healthDelta?: number
): ExperimentRecord {
  return {
    id,
    candidateHash: 'cafef00d',
    startedWallMs: 1,
    completedWallMs: 2,
    status,
    preHealth: { ...HEALTH },
    postHealth: { ...HEALTH },
    healthDelta,
    observedRefs: [],
    policyDecisionId: 'policy:test',
    transactionId: 'tx:test',
    rollbackVerified: status === 'ROLLED_BACK',
    epochStillFresh: status !== 'STALE',
  };
}

function temporalEdge(from: OpaqueRef, to: OpaqueRef): EventEdge {
  return {
    id: `edge:${from}:${to}:TRIGGERS_REACTION`,
    from,
    to,
    relation: 'TRIGGERS_REACTION',
    lagMs: { min: 0, max: 1500 },
    status: 'TEMPORAL_CANDIDATE',
    support: {
      observationalN: 1,
      interventionN: 0,
      positiveN: 0,
      negativeN: 0,
    },
    confounders: [],
    lastUpdatedWallMs: 0,
  };
}

function makeGraph(hyps: CausalHypothesis[], edges: EventEdge[] = []): EventGraph {
  const graph = createEmptyGraph(KEY, ORIGIN_HASH, 0);
  graph.hypotheses = hyps;
  graph.edges = edges;
  graph.budgets = { ...DEFAULT_EXPERIMENT_BUDGET };
  return graph;
}

function hyp(graph: EventGraph, id: CausalHypothesis['id']): CausalHypothesis {
  const found = graph.hypotheses.find((h) => h.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe('causal belief updater (M5)', () => {
  it('uses the document-epoch experiment budget of 3', () => {
    expect(DEFAULT_EXPERIMENT_BUDGET.maxPerDocumentEpoch).toBe(3);
  });

  it('true-cause series needs 5 COMMITTED successes before SUPPORT', () => {
    const hTrue = makeHyp('hypothesis:h1', { causeRefs: ['element:e1'] });
    const hDecoy = makeHyp('hypothesis:h2', { causeRefs: ['element:e2'] });
    const graph = makeGraph(
      [hTrue, hDecoy],
      [temporalEdge('element:e1', 'event:overlay'), temporalEdge('element:e2', 'event:overlay')]
    );
    const updater = new BeliefUpdater();

    updater.apply(graph, makeRecord('experiment:x1', 'COMMITTED', 0.2), 'hypothesis:h1');
    updater.apply(graph, makeRecord('experiment:x2', 'COMMITTED', 0.2), 'hypothesis:h1');
    updater.apply(graph, makeRecord('experiment:x3', 'COMMITTED', 0.2), 'hypothesis:h1');
    expect(hyp(graph, 'hypothesis:h1').status).toBe('CANDIDATE');
    updater.apply(graph, makeRecord('experiment:x4', 'COMMITTED', 0.2), 'hypothesis:h1');
    updater.apply(graph, makeRecord('experiment:x5', 'COMMITTED', 0.2), 'hypothesis:h1');

    const trueH = hyp(graph, 'hypothesis:h1');
    const decoyH = hyp(graph, 'hypothesis:h2');
    const belief = updater.getBelief('hypothesis:h1');
    const effect = updater.getEffect('hypothesis:h1');
    expect(belief).toBeDefined();
    expect(effect).toBeDefined();
    if (!belief || !effect) return;

    expect(observedN(belief)).toBe(5);
    expect(posteriorMean(belief)).toBeCloseTo(6 / 7, 5);
    expect(trueH.posterior).toBeCloseTo(6 / 7, 5);
    expect(trueH.status).toBe('SUPPORTED');
    expect(trueH.status).not.toBe('CONFIRMED');
    expect(trueH.updatedByExperiments).toEqual([
      'experiment:x1',
      'experiment:x2',
      'experiment:x3',
      'experiment:x4',
      'experiment:x5',
    ]);

    const decision = updater.decide(trueH, belief, effect, 5);
    expect(decision).toBe('SUPPORT');

    expect(decoyH.status).toBe('CANDIDATE');
    expect(decoyH.posterior).toBe(0.3);
    expect(decoyH.updatedByExperiments).toEqual([]);
    expect(updater.getBelief('hypothesis:h2')).toBeUndefined();
  });

  it('true-cause vs decoy: only the true cause may SUPPORT', () => {
    const hTrue = makeHyp('hypothesis:h1', { causeRefs: ['element:e1'] });
    const hDecoy = makeHyp('hypothesis:h2', { causeRefs: ['element:e2'] });
    const graph = makeGraph([hTrue, hDecoy], [
      temporalEdge('element:e1', 'event:overlay'),
      temporalEdge('element:e2', 'event:overlay'),
    ]);
    const updater = new BeliefUpdater();

    updater.apply(graph, makeRecord('experiment:x1', 'COMMITTED', 0.2), 'hypothesis:h1');
    updater.apply(graph, makeRecord('experiment:x2', 'COMMITTED', 0.2), 'hypothesis:h1');
    updater.apply(graph, makeRecord('experiment:x3', 'COMMITTED', 0.2), 'hypothesis:h1');
    updater.apply(graph, makeRecord('experiment:x7', 'COMMITTED', 0.2), 'hypothesis:h1');
    updater.apply(graph, makeRecord('experiment:x8', 'COMMITTED', 0.2), 'hypothesis:h1');

    updater.apply(graph, makeRecord('experiment:x4', 'ROLLED_BACK', -0.1), 'hypothesis:h2');
    updater.apply(graph, makeRecord('experiment:x5', 'ROLLED_BACK', -0.1), 'hypothesis:h2');
    updater.apply(graph, makeRecord('experiment:x6', 'ABORTED', -0.05), 'hypothesis:h2');

    const trueH = hyp(graph, 'hypothesis:h1');
    const decoyH = hyp(graph, 'hypothesis:h2');

    expect(trueH.status).toBe('SUPPORTED');
    expect(trueH.posterior).toBeGreaterThanOrEqual(0.8);
    expect(decoyH.status).not.toBe('SUPPORTED');
    expect(decoyH.status).not.toBe('CONFIRMED');
    expect(['REFUTED', 'CANDIDATE']).toContain(decoyH.status);
    expect(decoyH.posterior).toBeLessThan(0.5);

    const decoyBelief = updater.getBelief('hypothesis:h2');
    const decoyEffect = updater.getEffect('hypothesis:h2');
    expect(decoyBelief && decoyEffect).toBeTruthy();
    if (!decoyBelief || !decoyEffect) return;
    const decoyDecision = updater.decide(decoyH, decoyBelief, decoyEffect, 3);
    expect(decoyDecision).not.toBe('SUPPORT');
    expect(['REFUTE', 'STOP_UNCERTAIN']).toContain(decoyDecision);
  });

  it('confounded observational pair stays CANDIDATE and never SUPPORT', () => {
    const h1 = makeHyp('hypothesis:h1', { causeRefs: ['element:e1'] });
    const h2 = makeHyp('hypothesis:h2', { causeRefs: ['element:e2'] });
    const graph = makeGraph([h1, h2], [
      temporalEdge('element:e1', 'event:overlay'),
      temporalEdge('element:e2', 'event:overlay'),
    ]);
    const updater = new BeliefUpdater();

    expect(hyp(graph, 'hypothesis:h1').status).toBe('CANDIDATE');
    expect(hyp(graph, 'hypothesis:h2').status).toBe('CANDIDATE');
    expect(graph.edges.every((e) => e.status === 'TEMPORAL_CANDIDATE')).toBe(true);
    expect(graph.experiments).toHaveLength(0);

    const empty = emptyEffectEstimate();
    const d1 = updater.decide(h1, { ...UNIFORM_PRIOR }, empty, 0);
    const d2 = updater.decide(h2, { ...UNIFORM_PRIOR }, empty, 0);
    expect(['CONTINUE', 'STOP_UNCERTAIN']).toContain(d1);
    expect(['CONTINUE', 'STOP_UNCERTAIN']).toContain(d2);
    expect(d1).not.toBe('SUPPORT');
    expect(d2).not.toBe('SUPPORT');
    expect(hyp(graph, 'hypothesis:h1').status).toBe('CANDIDATE');
    expect(hyp(graph, 'hypothesis:h2').status).toBe('CANDIDATE');
    expect(hyp(graph, 'hypothesis:h1').posterior).toBe(0.3);
    expect(hyp(graph, 'hypothesis:h2').posterior).toBe(0.3);
  });

  it('tiny n: a single success stays CANDIDATE', () => {
    const graph = makeGraph([makeHyp('hypothesis:h1')]);
    const updater = new BeliefUpdater();
    updater.apply(graph, makeRecord('experiment:x1', 'COMMITTED', 0.2), 'hypothesis:h1');

    const h = hyp(graph, 'hypothesis:h1');
    const belief = updater.getBelief('hypothesis:h1');
    const effect = updater.getEffect('hypothesis:h1');
    expect(h.status).toBe('CANDIDATE');
    expect(belief).toBeDefined();
    expect(effect).toBeDefined();
    if (!belief || !effect) return;
    expect(observedN(belief)).toBe(1);
    expect(posteriorMean(belief)).toBeCloseTo(2 / 3, 5);
    expect(effect.n).toBe(1);
    expect(effect.ci95[0]).toBe(Number.NEGATIVE_INFINITY);
    expect(updater.decide(h, belief, effect, 1)).toBe('CONTINUE');
  });

  it('delayed/noisy: one success then one rollback stays near 0.5', () => {
    const graph = makeGraph([makeHyp('hypothesis:h1')]);
    const updater = new BeliefUpdater();
    updater.apply(graph, makeRecord('experiment:x1', 'COMMITTED', 0.2), 'hypothesis:h1');
    updater.apply(graph, makeRecord('experiment:x2', 'ROLLED_BACK', -0.15), 'hypothesis:h1');

    const h = hyp(graph, 'hypothesis:h1');
    const belief = updater.getBelief('hypothesis:h1');
    expect(h.status).toBe('CANDIDATE');
    expect(belief).toBeDefined();
    if (!belief) return;
    expect(posteriorMean(belief)).toBeCloseTo(0.5, 5);
    expect(h.posterior).toBeCloseTo(0.5, 5);
    expect(Math.abs(h.posterior - 0.5)).toBeLessThan(0.15);
  });

  it('healthDelta below minMeaningful is not counted as success', () => {
    const graph = makeGraph([makeHyp('hypothesis:h1')]);
    const updater = new BeliefUpdater();
    updater.apply(graph, makeRecord('experiment:x1', 'COMMITTED', 0.01), 'hypothesis:h1');

    const h = hyp(graph, 'hypothesis:h1');
    const belief = updater.getBelief('hypothesis:h1');
    expect(h.status).toBe('CANDIDATE');
    expect(belief).toBeDefined();
    if (!belief) return;
    expect(belief.alpha).toBe(UNIFORM_PRIOR.alpha);
    expect(posteriorMean(belief)).toBeLessThan(0.5 + 1e-9);
    expect(h.posterior).not.toBeCloseTo(2 / 3, 2);
  });

  it('STALE records are ignored', () => {
    const graph = makeGraph([makeHyp('hypothesis:h1')]);
    const updater = new BeliefUpdater();
    const before = { ...hyp(graph, 'hypothesis:h1') };
    updater.apply(graph, makeRecord('experiment:x1', 'STALE', 0.9), 'hypothesis:h1');

    const h = hyp(graph, 'hypothesis:h1');
    expect(h.status).toBe('CANDIDATE');
    expect(h.posterior).toBe(before.posterior);
    expect(h.updatedByExperiments).toEqual([]);
    expect(updater.getBelief('hypothesis:h1')).toBeUndefined();
    expect(graph.experiments).toHaveLength(0);
  });

  it('calibrates toward Bernoulli(p=0.8) and is not overconfident after 2 hits', () => {
    const twoHitGraph = makeGraph([makeHyp('hypothesis:h1')]);
    const twoHit = new BeliefUpdater();
    twoHit.apply(twoHitGraph, makeRecord('experiment:x1', 'COMMITTED', 0.2), 'hypothesis:h1');
    twoHit.apply(twoHitGraph, makeRecord('experiment:x2', 'COMMITTED', 0.2), 'hypothesis:h1');
    const afterTwo = hyp(twoHitGraph, 'hypothesis:h1').posterior;
    expect(afterTwo).toBeCloseTo(0.75, 5);
    expect(afterTwo).toBeLessThan(0.95);
    expect(afterTwo).not.toBe(1);

    const series: Array<0 | 1> = [1, 1, 1, 0, 1, 1, 0, 1, 1, 1];
    const hitRate = series.reduce((a: number, b) => a + b, 0) / series.length;
    expect(hitRate).toBeCloseTo(0.8, 5);

    const graph = makeGraph([makeHyp('hypothesis:h9')]);
    const updater = new BeliefUpdater();
    for (let i = 0; i < series.length; i++) {
      const success = series[i] === 1;
      const rec = makeRecord(
        `experiment:x${i + 1}`,
        success ? 'COMMITTED' : 'ROLLED_BACK',
        success ? 0.2 : -0.1
      );
      updater.apply(graph, rec, 'hypothesis:h9');
    }
    const belief = updater.getBelief('hypothesis:h9');
    expect(belief).toBeDefined();
    if (!belief) return;
    const mean = posteriorMean(belief);
    expect(Math.abs(mean - 0.8)).toBeLessThan(0.2);
    expect(mean).toBeLessThan(0.99);
    expect(hyp(graph, 'hypothesis:h9').status).not.toBe('CONFIRMED');
  });

  it('futility: 3 failures REFUTE or STOP_UNCERTAIN, never SUPPORT', () => {
    const graph = makeGraph([makeHyp('hypothesis:h1')]);
    const updater = new BeliefUpdater();
    updater.apply(graph, makeRecord('experiment:x1', 'ROLLED_BACK', -0.2), 'hypothesis:h1');
    updater.apply(graph, makeRecord('experiment:x2', 'ABORTED', -0.1), 'hypothesis:h1');
    updater.apply(graph, makeRecord('experiment:x3', 'ROLLED_BACK', -0.05), 'hypothesis:h1');

    const h = hyp(graph, 'hypothesis:h1');
    const belief = updater.getBelief('hypothesis:h1');
    const effect = updater.getEffect('hypothesis:h1');
    expect(belief && effect).toBeTruthy();
    if (!belief || !effect) return;

    expect(h.status).not.toBe('SUPPORTED');
    expect(h.status).not.toBe('CONFIRMED');
    expect(['REFUTED', 'CANDIDATE']).toContain(h.status);
    expect(posteriorMean(belief)).toBeCloseTo(0.2, 5);

    const decision = updater.decide(h, belief, effect, 3);
    expect(decision).not.toBe('SUPPORT');
    expect(['REFUTE', 'STOP_UNCERTAIN']).toContain(decision);
  });
});
