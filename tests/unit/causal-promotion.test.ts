import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { BeliefUpdater } from '../../src/background/causal/belief-updater';
import { NOOP_SESSION_ALLOW_FILTER } from '../../src/background/causal/experiment-to-strategy';
import {
  CausalRecipeStore,
  PromotionGate,
  PromotionEvaluateInput,
} from '../../src/background/causal/promotion-gate';
import { DEFAULT_SEQUENTIAL_BOUNDS } from '../../src/shared/causal/belief';
import {
  CausalHypothesis,
  EventGraph,
  ExperimentRecord,
  HealthVectorCompact,
  OpaqueRef,
} from '../../src/shared/causal/events';
import { createEmptyGraph, DEFAULT_EXPERIMENT_BUDGET } from '../../src/shared/causal/graph';
import {
  CausalRecipe,
  MIN_PRIVACY_SCORE_FOR_PROMOTION,
  PageFingerprint,
  RECIPE_SAFE_MIN_STABLE_REPLAYS,
  checkFingerprint,
  createPageFingerprint,
  defaultConstraints,
  fingerprintEvidenceHash,
  pathClassMatches,
} from '../../src/shared/causal/recipes';
import { STORAGE_KEYS } from '../../src/shared/constants';
import { StorageBackend } from '../../src/core/recipes/store';
import { StrategyAction, StrategyCandidate } from '../../src/shared/types';

const ORIGIN_HASH = '100680ad546ce6a577f42f52df33b4cfdca756859e664b8d7de329b150d09ce9';
const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/causal/replay');
const EXPECTED_HEALTH = 0.3;

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

const BASE_FP: PageFingerprint = createPageFingerprint({
  originHash: ORIGIN_HASH,
  topLevelPathClass: 'article',
  detectorFeatureHash: 'det:overlay-v1',
  relevantResourceSetHash: 'res:set-v1',
  structuralFeatureHash: 'str:dom-v1',
  createdWallMs: 1700000000000,
});

const SAFE_ACTIONS: StrategyAction[] = [
  { id: 'dom_overlay_x1', type: 'DOM_REMOVE_OVERLAY' },
  { id: 'dom_pointer_x1', type: 'DOM_RESTORE_POINTER_EVENTS' },
];

const SAFE_REFS: OpaqueRef[] = ['strategy:s2', 'element:e1'];

interface ReplayVisit {
  visit: number;
  fingerprint: PageFingerprint;
  healthDelta: number;
  success: boolean;
  changedField?: string;
  expectMatch?: boolean;
}

interface ReplayCorpus {
  id: string;
  kind: string;
  originHash: string;
  expectedHealthDelta: number;
  fingerprint?: PageFingerprint;
  baselineFingerprint?: PageFingerprint;
  visits: ReplayVisit[];
}

function loadCorpus(name: string): ReplayCorpus {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
  return raw as ReplayCorpus;
}

function makeHyp(extras?: Partial<CausalHypothesis>): CausalHypothesis {
  return {
    id: 'hypothesis:h1',
    causeRefs: ['element:e1'],
    outcome: 'ANTI_BLOCK_REACTION',
    mechanismClass: 'OVERLAY_REINSERTION',
    prior: 0.3,
    posterior: 0.8,
    confoundingRisk: 'LOW',
    status: 'SUPPORTED',
    createdFrom: ['event:overlay'],
    updatedByExperiments: ['experiment:x1', 'experiment:x2', 'experiment:x3', 'experiment:x4', 'experiment:x5'],
    ...extras,
  };
}

function makeRecord(
  id: ExperimentRecord['id'],
  status: ExperimentRecord['status'],
  healthDelta: number,
  rollbackVerified = true,
  replay = false,
  visitId = `visit:${id}`
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
    transactionId: `tx:${id}`,
    rollbackVerified,
    epochStillFresh: status !== 'STALE',
    visitId,
    fingerprintHash: fingerprintEvidenceHash(BASE_FP),
    replay,
    privacyScore: 0.95,
  };
}

function committedTrio(): ExperimentRecord[] {
  return [
    makeRecord('experiment:x1', 'COMMITTED', 0.2, true),
    makeRecord('experiment:x2', 'COMMITTED', 0.2, true),
    makeRecord('experiment:x3', 'COMMITTED', 0.2, true),
    makeRecord('experiment:x4', 'COMMITTED', 0.2, true, true, 'visit:replay-1'),
    makeRecord('experiment:x5', 'COMMITTED', 0.2, true, true, 'visit:replay-2'),
  ];
}

function mappedOverlay(): StrategyCandidate {
  return {
    id: 'causal_cand_experiment:x1',
    tier: 'S3',
    name: 'Causal: remove overlay gate',
    rationale: 'Mapped intervention remove_overlay_gate to a reversible Phase 1 strategy (one variable).',
    actions: SAFE_ACTIONS,
    isReversible: true,
    estimatedRisk: 'LOW',
  };
}

function baseInput(overrides?: Partial<PromotionEvaluateInput>): PromotionEvaluateInput {
  return {
    hypothesis: makeHyp(),
    fingerprint: { ...BASE_FP },
    actionRefs: [...SAFE_REFS],
    actions: [...SAFE_ACTIONS],
    expectedHealthDelta: EXPECTED_HEALTH,
    minPrivacyScore: 0.95,
    rollbackPlanRef: 'rollback:overlay-gate',
    preconditions: ['mechanism:OVERLAY_REINSERTION'],
    stableReplays: RECIPE_SAFE_MIN_STABLE_REPLAYS,
    experiments: committedTrio(),
    mappedStrategy: mappedOverlay(),
    ...overrides,
  };
}

function memoryBackend(): StorageBackend {
  let data: Record<string, unknown> = {};
  return {
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (k in data) {
          const v = data[k];
          if (v !== undefined) out[k] = v;
        }
      }
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    },
    remove: async (keys: string[]) => {
      const next: Record<string, unknown> = { ...data };
      for (const k of keys) {
        delete next[k];
      }
      data = next;
    },
  };
}

/** Deterministic generator used in-file (spec corpus ≥100). */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateStableVisits(count: number, seed = 0xadad013): ReplayVisit[] {
  const rnd = mulberry32(seed);
  const visits: ReplayVisit[] = [];
  for (let i = 0; i < count; i++) {
    const jitter = (rnd() - 0.5) * 0.06;
    let healthDelta = EXPECTED_HEALTH + jitter;
    if (healthDelta < EXPECTED_HEALTH * 0.5) healthDelta = EXPECTED_HEALTH * 0.6;
    visits.push({
      visit: i + 1,
      fingerprint: { ...BASE_FP },
      healthDelta,
      success: true,
    });
  }
  return visits;
}

function generateChangedVisits(count: number, seed = 0xc0ffee): ReplayVisit[] {
  const rnd = mulberry32(seed);
  const visits: ReplayVisit[] = [];
  for (let i = 0; i < count; i++) {
    const fp: PageFingerprint = { ...BASE_FP };
    if (i % 2 === 0) {
      fp.detectorFeatureHash = `det:overlay-redesign-${i + 1}`;
    } else {
      fp.structuralFeatureHash = `str:dom-redesign-${i + 1}`;
    }
    const jitter = (rnd() - 0.5) * 0.06;
    visits.push({
      visit: i + 1,
      fingerprint: fp,
      healthDelta: EXPECTED_HEALTH + jitter,
      success: true,
      changedField: i % 2 === 0 ? 'detectorFeatureHash' : 'structuralFeatureHash',
    });
  }
  return visits;
}

describe('causal promotion gate (M6)', () => {
  it('SUPPORTED + 0 replays → evaluate FAIL (replay gate)', () => {
    const gate = new PromotionGate();
    const hyp = makeHyp();
    const draft = gate.compileDraft(baseInput({ hypothesis: hyp, stableReplays: 0 }));
    expect(draft).not.toBeNull();
    if (draft === null) return;
    expect(draft.id).toMatch(/^recipe:rcp\d+$/);
    expect(draft.version).toBe(1);
    expect(draft.causalSupport.stableReplays).toBe(0);
    expect(hyp.status).toBe('SUPPORTED');
    expect(hyp.status).not.toBe('CONFIRMED');

    const result = gate.evaluate(baseInput({ hypothesis: hyp, stableReplays: 0 }));
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.failedGates).toContain('replay');
    expect(hyp.status).toBe('SUPPORTED');
    expect(hyp.status).not.toBe('CONFIRMED');
  });

  it('SUPPORTED + 2 stable replays + all gates → PASS, recipe id recipe:rcpN', () => {
    const gate = new PromotionGate();
    const hyp = makeHyp();
    const result = gate.evaluate(baseInput({ hypothesis: hyp }));
    expect(result.pass).toBe(true);
    if (!result.pass) return;
    expect(result.recipe.id).toMatch(/^recipe:rcp\d+$/);
    expect(result.recipe.version).toBe(1);
    expect(result.recipe.originHash).toBe(ORIGIN_HASH);
    expect(result.recipe.causalSupport.stableReplays).toBeGreaterThanOrEqual(2);
    expect(result.recipe.causalSupport.experiments).toBeGreaterThanOrEqual(3);
    expect(result.recipe.causalSupport.posterior).toBeGreaterThanOrEqual(
      DEFAULT_SEQUENTIAL_BOUNDS.supportPosterior
    );
    expect(result.recipe.minPrivacyScore).toBeGreaterThanOrEqual(MIN_PRIVACY_SCORE_FOR_PROMOTION);
    expect(result.recipe.rollbackPlanRef.length).toBeGreaterThan(0);
    expect(gate.getLifecycle(result.recipe.id)).toBe('RECIPE_SAFE');
    expect(hyp.status).toBe('CONFIRMED');
  });

  it('privacy fail if someone tries to attach a tracker-allow action', () => {
    const gate = new PromotionGate();
    const trackerAllow: StrategyAction = {
      id: 'allow_tracker',
      type: 'NET_ALLOW_EXCEPTION',
      urlFilter: '||doubleclick.net^',
    };
    const hyp = makeHyp();
    const result = gate.evaluate(
      baseInput({
        hypothesis: hyp,
        actions: [trackerAllow],
        mappedStrategy: {
          ...mappedOverlay(),
          actions: [trackerAllow],
        },
      })
    );
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.failedGates).toContain('privacy');
    expect(hyp.status).not.toBe('CONFIRMED');
  });

  it('rejects a meaningless .invalid network exception', () => {
    const gate = new PromotionGate();
    const noop: StrategyAction = {
      id: 'net_allow_noop',
      type: 'NET_ALLOW_EXCEPTION',
      urlFilter: NOOP_SESSION_ALLOW_FILTER,
    };
    const result = gate.evaluate(
      baseInput({
        actions: [noop],
        actionRefs: ['strategy:s1'],
        mappedStrategy: {
          id: 'causal_cand_net',
          tier: 'S1',
          name: 'Causal: session network exception',
          rationale: 'Mapped intervention temp_network_exception to a reversible Phase 1 strategy (one variable).',
          actions: [noop],
          isReversible: true,
          estimatedRisk: 'LOW',
        },
      })
    );
    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.failedGates).toContain('safety');
  });

  it('fingerprint path-class mismatch does not assume equivalence (do not replay)', () => {
    const gate = new PromotionGate();
    const hyp = makeHyp();
    const promoted = gate.evaluate(baseInput({ hypothesis: hyp }));
    expect(promoted.pass).toBe(true);
    if (!promoted.pass) return;

    const homeFp: PageFingerprint = { ...BASE_FP, topLevelPathClass: 'home' };
    const replayed = gate.replay(promoted.recipe, homeFp, EXPECTED_HEALTH, true);
    expect(replayed.applied).toBe(false);
    expect(replayed.lifecycle).not.toBe('INVALIDATED');
    expect(replayed.recipe.causalSupport.stableReplays).toBe(
      promoted.recipe.causalSupport.stableReplays
    );
    expect(pathClassMatches('article', 'home')).toBe(false);
    expect(pathClassMatches('article', 'article/sports')).toBe(true);
  });

  it('health failure on matching fingerprint → Invalidated', () => {
    const gate = new PromotionGate();
    const promoted = gate.evaluate(baseInput());
    expect(promoted.pass).toBe(true);
    if (!promoted.pass) return;

    const failed = gate.replay(promoted.recipe, { ...BASE_FP }, 0.01, false);
    expect(failed.lifecycle).toBe('INVALIDATED');
    expect(failed.applied).toBe(false);
    expect(gate.getLifecycle(promoted.recipe.id)).toBe('INVALIDATED');
  });

  it('never writes CONFIRMED from a single COMMITTED experiment', () => {
    const graph: EventGraph = createEmptyGraph(
      { tabId: 1, navigationEpoch: 1, documentId: 'doc-m6', frameId: 0 },
      ORIGIN_HASH,
      0
    );
    graph.budgets = { ...DEFAULT_EXPERIMENT_BUDGET };
    const hyp = makeHyp({
      status: 'CANDIDATE',
      posterior: 0.3,
      updatedByExperiments: [],
    });
    graph.hypotheses = [hyp];
    const updater = new BeliefUpdater();
    updater.apply(graph, makeRecord('experiment:x1', 'COMMITTED', 0.2, true), 'hypothesis:h1');
    expect(hyp.status).toBe('CANDIDATE');
    expect(hyp.status).not.toBe('CONFIRMED');
    expect(hyp.status).not.toBe('SUPPORTED');

    const gate = new PromotionGate();
    const forced = makeHyp({
      status: 'SUPPORTED',
      posterior: 0.8,
      updatedByExperiments: ['experiment:x1'],
    });
    const result = gate.evaluate(
      baseInput({
        hypothesis: forced,
        experiments: [makeRecord('experiment:x1', 'COMMITTED', 0.2, true)],
        stableReplays: 2,
      })
    );
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.failedGates).toContain('statistical');
    expect(forced.status).not.toBe('CONFIRMED');
  });

  it('evaluatePromotion is the same fail-closed gate as evaluate', () => {
    const gate = new PromotionGate();
    const a = gate.evaluate(baseInput({ stableReplays: 0 }));
    const b = gate.evaluatePromotion(baseInput({ stableReplays: 0 }));
    expect(a.pass).toBe(false);
    expect(b.pass).toBe(false);
    if (a.pass || b.pass) return;
    expect(a.failedGates).toContain('replay');
    expect(b.failedGates).toContain('replay');
  });

  it('CANDIDATE / REFUTED fail safety and never confirm', () => {
    const gate = new PromotionGate();
    for (const status of ['CANDIDATE', 'REFUTED'] as const) {
      const hyp = makeHyp({ status });
      const result = gate.evaluate(baseInput({ hypothesis: hyp }));
      expect(result.pass).toBe(false);
      if (result.pass) continue;
      expect(result.failedGates).toContain('safety');
      expect(hyp.status).toBe(status);
    }
  });

  it('form/auth/paywall actions fail safety', () => {
    const gate = new PromotionGate();
    const hyp = makeHyp();
    const result = gate.evaluate(
      baseInput({
        hypothesis: hyp,
        actions: [{ id: 'dom_paywall', type: 'DOM_HIDE', description: 'bypass paywall overlay' }],
      })
    );
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.failedGates).toContain('safety');
    expect(hyp.status).not.toBe('CONFIRMED');
  });

  it('minPrivacyScore below 0.9 fails privacy', () => {
    const gate = new PromotionGate();
    const result = gate.evaluate(baseInput({ minPrivacyScore: 0.85 }));
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.failedGates).toContain('privacy');
  });

  it('empty rollbackPlanRef fails rollback', () => {
    const gate = new PromotionGate();
    const result = gate.evaluate(baseInput({ rollbackPlanRef: '' }));
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.failedGates).toContain('rollback');
  });

  it('missing originHash constraint fails fingerprint', () => {
    const gate = new PromotionGate();
    const result = gate.evaluate(
      baseInput({
        fingerprintConstraints: { topLevelPathClass: 'article' },
      })
    );
    expect(result.pass).toBe(false);
    if (result.pass) return;
    expect(result.failedGates).toContain('fingerprint');
  });

  it('matching fingerprint + success increments stableReplays and keeps RecipeSafe', () => {
    const gate = new PromotionGate();
    const promoted = gate.evaluate(baseInput());
    expect(promoted.pass).toBe(true);
    if (!promoted.pass) return;
    const before = promoted.recipe.causalSupport.stableReplays;
    const next = gate.replay(promoted.recipe, { ...BASE_FP }, EXPECTED_HEALTH, true);
    expect(next.applied).toBe(true);
    expect(next.lifecycle).toBe('RECIPE_SAFE');
    expect(next.recipe.causalSupport.stableReplays).toBe(before + 1);
  });

  it('origin/detector/structural mismatch invalidates immediately', () => {
    const gate = new PromotionGate();
    const promoted = gate.evaluate(baseInput());
    expect(promoted.pass).toBe(true);
    if (!promoted.pass) return;

    const det: PageFingerprint = { ...BASE_FP, detectorFeatureHash: 'det:new' };
    const r1 = gate.replay(promoted.recipe, det, EXPECTED_HEALTH, true);
    expect(r1.lifecycle).toBe('INVALIDATED');
    expect(r1.applied).toBe(false);

    const gate2 = new PromotionGate();
    const p2 = gate2.evaluate(baseInput());
    expect(p2.pass).toBe(true);
    if (!p2.pass) return;
    const str: PageFingerprint = { ...BASE_FP, structuralFeatureHash: 'str:new' };
    const r2 = gate2.replay(p2.recipe, str, EXPECTED_HEALTH, true);
    expect(r2.lifecycle).toBe('INVALIDATED');

    const gate3 = new PromotionGate();
    const p3 = gate3.evaluate(baseInput());
    expect(p3.pass).toBe(true);
    if (!p3.pass) return;
    const origin: PageFingerprint = { ...BASE_FP, originHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
    const r3 = gate3.replay(p3.recipe, origin, EXPECTED_HEALTH, true);
    expect(r3.lifecycle).toBe('INVALIDATED');
  });

  it('pathClassMatches is prefix/class, not global equivalence', () => {
    expect(pathClassMatches('article', 'article')).toBe(true);
    expect(pathClassMatches('article', 'article/sports')).toBe(true);
    expect(pathClassMatches('article', 'home')).toBe(false);
    expect(pathClassMatches('article', 'article-old')).toBe(false);
    expect(checkFingerprint(defaultConstraints(BASE_FP), { ...BASE_FP, topLevelPathClass: 'home' }).kind).toBe(
      'PATH_CLASS_MISMATCH'
    );
  });

  it('CausalRecipeStore persists via STORAGE_KEYS.CAUSAL_RECIPES', async () => {
    const backend = memoryBackend();
    const store = new CausalRecipeStore(backend);
    const gate = new PromotionGate({ store });
    const result = gate.evaluate(baseInput());
    expect(result.pass).toBe(true);
    if (!result.pass) return;
    const lifecycle = gate.getLifecycle(result.recipe.id);
    expect(lifecycle).toBe('RECIPE_SAFE');
    await store.save({
      recipe: result.recipe,
      lifecycle: 'RECIPE_SAFE',
      updatedWallMs: 1,
    });
    const loaded = await store.getRecipe(result.recipe.id);
    expect(loaded?.recipe.id).toBe(result.recipe.id);
    expect(loaded?.lifecycle).toBe('RECIPE_SAFE');
    const raw = await backend.get([STORAGE_KEYS.CAUSAL_RECIPES]);
    expect(raw[STORAGE_KEYS.CAUSAL_RECIPES]).toBeDefined();
  });
});

describe('M6 replay corpora (≥99% gates)', () => {
  it('stable replay corpus ≥100 visits keeps RecipeSafe at ≥99%', () => {
    const fileCorpus = loadCorpus('stable-corpus.json');
    const generated = generateStableVisits(120);
    expect(fileCorpus.visits.length).toBeGreaterThanOrEqual(100);
    expect(generated.length).toBeGreaterThanOrEqual(100);

    const gate = new PromotionGate();
    const promoted = gate.evaluate(baseInput());
    expect(promoted.pass).toBe(true);
    if (!promoted.pass) return;

    let keep = 0;
    let current: CausalRecipe = promoted.recipe;
    for (const visit of fileCorpus.visits) {
      const out = gate.replay(current, visit.fingerprint, visit.healthDelta, visit.success);
      if (out.lifecycle === 'RECIPE_SAFE') keep += 1;
      current = out.recipe;
    }
    const fileRate = keep / fileCorpus.visits.length;
    expect(fileRate).toBeGreaterThanOrEqual(0.99);

    const gate2 = new PromotionGate();
    const p2 = gate2.evaluate(baseInput());
    expect(p2.pass).toBe(true);
    if (!p2.pass) return;
    let keep2 = 0;
    let cur2: CausalRecipe = p2.recipe;
    for (const visit of generated) {
      const out = gate2.replay(cur2, visit.fingerprint, visit.healthDelta, visit.success);
      if (out.lifecycle === 'RECIPE_SAFE') keep2 += 1;
      cur2 = out.recipe;
    }
    const genRate = keep2 / generated.length;
    expect(genRate).toBeGreaterThanOrEqual(0.99);
    // Surface rates for the M6 report.
    expect({ stableFileRate: fileRate, stableGeneratedRate: genRate }).toEqual({
      stableFileRate: fileRate,
      stableGeneratedRate: genRate,
    });
  });

  it('changed fixtures ≥100 visits invalidate at ≥99%', () => {
    const fileCorpus = loadCorpus('changed-corpus.json');
    const generated = generateChangedVisits(120);
    expect(fileCorpus.visits.length).toBeGreaterThanOrEqual(100);
    expect(generated.length).toBeGreaterThanOrEqual(100);

    let invalidated = 0;
    for (const visit of fileCorpus.visits) {
      const named = new PromotionGate();
      const once = named.evaluate(baseInput());
      if (!once.pass) continue;
      const out = named.replay(once.recipe, visit.fingerprint, visit.healthDelta, visit.success);
      if (out.lifecycle === 'INVALIDATED') invalidated += 1;
    }
    const fileRate = invalidated / fileCorpus.visits.length;
    expect(fileRate).toBeGreaterThanOrEqual(0.99);

    let inv2 = 0;
    for (const visit of generated) {
      const named = new PromotionGate();
      const once = named.evaluate(baseInput());
      if (!once.pass) continue;
      const out = named.replay(once.recipe, visit.fingerprint, visit.healthDelta, visit.success);
      if (out.lifecycle === 'INVALIDATED') inv2 += 1;
    }
    const genRate = inv2 / generated.length;
    expect(genRate).toBeGreaterThanOrEqual(0.99);
    expect({ changedFileRate: fileRate, changedGeneratedRate: genRate }).toEqual({
      changedFileRate: fileRate,
      changedGeneratedRate: genRate,
    });
  });

  it('path-class mismatch fixture does not replay', () => {
    const corpus = loadCorpus('path-class-mismatch.json');
    const gate = new PromotionGate();
    const promoted = gate.evaluate(baseInput());
    expect(promoted.pass).toBe(true);
    if (!promoted.pass) return;

    const home = corpus.visits[0];
    expect(home).toBeDefined();
    if (home === undefined) return;
    const out = gate.replay(promoted.recipe, home.fingerprint, home.healthDelta, home.success);
    expect(out.applied).toBe(false);
    expect(out.lifecycle).toBe('RECIPE_SAFE');
  });
});
