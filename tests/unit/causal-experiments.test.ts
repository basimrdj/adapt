import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CandidateGenerator } from '../../src/background/causal/candidate-generator';
import { ExperimentGenerator } from '../../src/background/causal/experiment-generator';
import { ExperimentSelector } from '../../src/background/causal/experiment-selector';
import { validateCausalDecision } from '../../src/background/ai/causal-policy-validator';
import {
  addNode,
  createEmptyGraph,
  DEFAULT_EXPERIMENT_BUDGET,
} from '../../src/shared/causal/graph';
import {
  CausalDocumentKey,
  CausalHypothesis,
  EventKind,
  EventNode,
  EventProvenance,
  OpaqueRef,
  causalKeyFromNode,
} from '../../src/shared/causal/events';
import {
  CausalPlannerDecisionV1,
  CurrentEpochState,
  EvidencePacketV3,
  ExperimentCandidate,
  ExperimentSelectionBudget,
  STRATEGY_REF_ALLOWLIST,
  buildMinimalPacket,
  experimentUtility,
} from '../../src/shared/causal/experiments';

const ORIGIN_HASH = '100680ad546ce6a577f42f52df33b4cfdca756859e664b8d7de329b150d09ce9';
const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/causal');

interface CausalFixture {
  id: string;
  nodes: EventNode[];
}

function loadFixture(name: string): CausalFixture {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
  return raw as CausalFixture;
}

function makeNode(partial: {
  id: EventNode['id'];
  kind: EventKind;
  tabId?: number;
  navigationEpoch?: number;
  documentId?: string;
  frameId?: number;
  originHash?: string;
  t: number;
  domain?: EventNode['timestamp']['domain'];
  features?: EventNode['features'];
  refs?: OpaqueRef[];
  provenance?: EventProvenance;
  observationConfidence?: number;
}): EventNode {
  return {
    id: partial.id,
    kind: partial.kind,
    scope: {
      tabId: partial.tabId ?? 1,
      navigationEpoch: partial.navigationEpoch ?? 1,
      documentId: partial.documentId ?? 'doc-fixture',
      frameId: partial.frameId ?? 0,
      originHash: partial.originHash ?? ORIGIN_HASH,
    },
    timestamp: {
      value: partial.t,
      domain: partial.domain ?? 'extension.monotonic_ms',
    },
    refs: partial.refs ?? [],
    features: partial.features ?? {},
    provenance: partial.provenance ?? 'mutationObserver',
    observationConfidence: partial.observationConfidence ?? 1,
  };
}

function graphFromFixture(name: string) {
  const fixture = loadFixture(name);
  const first = fixture.nodes[0];
  if (!first) throw new Error(`empty fixture ${name}`);
  const graph = createEmptyGraph(causalKeyFromNode(first), first.scope.originHash);
  for (const n of fixture.nodes) {
    addNode(graph, n);
  }
  new CandidateGenerator().update(graph);
  const experiments = new ExperimentGenerator().generate(graph);
  return { graph, experiments, fixture };
}

function selectionBudget(
  remaining: number,
  extra?: Partial<ExperimentSelectionBudget>
): ExperimentSelectionBudget {
  return { ...DEFAULT_EXPERIMENT_BUDGET, remaining, ...extra };
}

function makeCandidate(overrides: {
  id?: ExperimentCandidate['id'];
  hypothesisRef?: ExperimentCandidate['hypothesisRef'];
  variable?: string;
  actionRefs?: OpaqueRef[];
  desiredValue?: string | number | boolean;
  scope?: Partial<ExperimentCandidate['scope']>;
  expected?: Partial<ExperimentCandidate['expected']>;
  controls?: Partial<ExperimentCandidate['controls']>;
  rollbackPlanRef?: string;
} = {}): ExperimentCandidate {
  return {
    id: overrides.id ?? 'experiment:x1',
    hypothesisRef: overrides.hypothesisRef ?? 'hypothesis:h1',
    intervention: {
      variable: overrides.variable ?? 'restore_scroll',
      actionRefs: overrides.actionRefs ?? [STRATEGY_REF_ALLOWLIST.RESTORE_SCROLL],
      desiredValue: overrides.desiredValue ?? true,
    },
    scope: {
      tabId: overrides.scope?.tabId ?? 1,
      navigationEpoch: overrides.scope?.navigationEpoch ?? 1,
      documentId: overrides.scope?.documentId ?? 'doc-a',
      frameIds: overrides.scope?.frameIds ?? [0],
    },
    expected: {
      informationGain: overrides.expected?.informationGain ?? 0.4,
      healthRisk: overrides.expected?.healthRisk ?? 0.1,
      privacyRisk: overrides.expected?.privacyRisk ?? 0.01,
      rollbackConfidence: overrides.expected?.rollbackConfidence ?? 0.998,
      durationMs: overrides.expected?.durationMs ?? 800,
    },
    controls: {
      oneVariable: overrides.controls?.oneVariable ?? true,
      requiresReload: overrides.controls?.requiresReload ?? false,
      pairedBaselineAvailable: overrides.controls?.pairedBaselineAvailable ?? false,
    },
    rollbackPlanRef: overrides.rollbackPlanRef ?? 'rollback:restore_scroll',
  };
}

function makeHypothesis(overrides: Partial<CausalHypothesis> & Pick<CausalHypothesis, 'id'>): CausalHypothesis {
  return {
    causeRefs: ['request:r1'],
    outcome: 'ANTI_BLOCK_REACTION',
    mechanismClass: 'BLOCKED_RESOURCE_PROBE',
    prior: 0.3,
    posterior: 0.3,
    confoundingRisk: 'MEDIUM',
    status: 'CANDIDATE',
    createdFrom: ['event:a'],
    updatedByExperiments: [],
    ...overrides,
  };
}

const NOW: CurrentEpochState = {
  tabId: 1,
  navigationEpoch: 1,
  documentId: 'doc-a',
  frameId: 0,
};

function wellFormedExperiment(ref: `experiment:x${number}`, hyp: `hypothesis:h${number}`): CausalPlannerDecisionV1 {
  return {
    schemaVersion: 'causal-plan-1',
    decision: 'EXPERIMENT',
    experimentRef: ref,
    hypothesisRef: hyp,
    reasonCode: 'MAX_INFORMATION_GAIN_SAFE',
    confidence: 0.7,
  };
}

describe('ExperimentGenerator (M3)', () => {
  it('emits one-variable candidates for BLOCKED_RESOURCE_PROBE / BAIT / OVERLAY_REINSERTION / SCROLL_LOCK', () => {
    const cases: Array<{
      file: string;
      mechanism: CausalHypothesis['mechanismClass'];
      variable: string;
    }> = [
      {
        file: 'bait-then-overlay.json',
        mechanism: 'BAIT_VISIBILITY_PROBE',
        variable: 'preserve_bait_geometry',
      },
      {
        file: 'overlay-reinsertion.json',
        mechanism: 'OVERLAY_REINSERTION',
        variable: 'remove_overlay_gate',
      },
      {
        file: 'script-scroll-lock.json',
        mechanism: 'SCROLL_LOCK_REACTION',
        variable: 'restore_scroll',
      },
    ];

    for (const c of cases) {
      const { graph, experiments } = graphFromFixture(c.file);
      expect(graph.hypotheses.some((h) => h.mechanismClass === c.mechanism)).toBe(true);
      expect(experiments).toHaveLength(1);
      const x = experiments[0]!;
      expect(x.controls.oneVariable).toBe(true);
      expect(x.intervention.variable).toBe(c.variable);
      expect(x.intervention.actionRefs.every((r) => !r.includes('{') && !r.startsWith('.') && !r.startsWith('#'))).toBe(
        true
      );
      expect(x.intervention.actionRefs.some((r) => r.startsWith('strategy:s'))).toBe(true);
      expect(x.hypothesisRef).toBe(graph.hypotheses[0]?.id);
      expect(x.expected.informationGain).toBeGreaterThanOrEqual(0);
      expect(x.expected.informationGain).toBeLessThanOrEqual(1);
      expect(x.expected.healthRisk).toBeLessThanOrEqual(graph.budgets.maxHealthRisk);
      expect(x.expected.privacyRisk).toBeLessThanOrEqual(graph.budgets.maxPrivacyRisk);
      expect(x.expected.rollbackConfidence).toBeGreaterThanOrEqual(graph.budgets.minRollbackConfidence);
    }
  });

  it('records blocked-request hypotheses but abstains without a safe retry protocol', () => {
    const { graph, experiments } = graphFromFixture('blocked-request-overlay.json');
    expect(graph.hypotheses.some((h) => h.mechanismClass === 'BLOCKED_RESOURCE_PROBE')).toBe(true);
    expect(graph.hypotheses[0]?.causeRefs).toContain('request:r12');
    expect(experiments).toHaveLength(0);
  });

  it('emits nothing for benign consent/login', () => {
    for (const name of ['benign-consent.json', 'benign-login.json'] as const) {
      const { graph, experiments } = graphFromFixture(name);
      expect(graph.hypotheses).toHaveLength(0);
      expect(experiments).toHaveLength(0);
    }
  });

  it('skips UNKNOWN and SERVICE_WORKER_CACHE_PATH', () => {
    const key: CausalDocumentKey = {
      tabId: 1,
      navigationEpoch: 1,
      documentId: 'doc-skip',
      frameId: 0,
    };
    const graph = createEmptyGraph(key, ORIGIN_HASH);
    addNode(
      graph,
      makeNode({
        id: 'event:skip-cause',
        kind: 'REQUEST_ERROR',
        t: 0,
        documentId: 'doc-skip',
        provenance: 'webRequest',
        features: { blocked: true },
        refs: ['request:r9'],
      })
    );
    addNode(
      graph,
      makeNode({
        id: 'event:skip-out',
        kind: 'OVERLAY_APPEARED',
        t: 100,
        documentId: 'doc-skip',
      })
    );
    graph.hypotheses = [
      makeHypothesis({
        id: 'hypothesis:h1',
        mechanismClass: 'UNKNOWN',
        createdFrom: ['event:skip-cause', 'event:skip-out'],
      }),
      makeHypothesis({
        id: 'hypothesis:h2',
        mechanismClass: 'SERVICE_WORKER_CACHE_PATH',
        outcome: 'PAGE_BREAKAGE',
        confoundingRisk: 'HIGH',
        createdFrom: ['event:skip-cause', 'event:skip-out'],
      }),
    ];
    const experiments = new ExperimentGenerator().generate(graph);
    expect(experiments).toHaveLength(0);
  });

  it('emits at most one candidate per CANDIDATE hypothesis and never oneVariable=false', () => {
    const { graph, experiments } = graphFromFixture('blocked-request-overlay.json');
    expect(experiments.length).toBeLessThanOrEqual(graph.hypotheses.filter((h) => h.status === 'CANDIDATE').length);
    expect(experiments.every((x) => x.controls.oneVariable)).toBe(true);
  });
});

describe('ExperimentSelector (M3)', () => {
  const selector = new ExperimentSelector();

  it('picks lower-risk over higher-IG-but-over-ceiling', () => {
    const unsafeHighIg = makeCandidate({
      id: 'experiment:x9',
      expected: { informationGain: 0.99, healthRisk: 0.55, privacyRisk: 0.01, rollbackConfidence: 0.999, durationMs: 500 },
    });
    const safeLowerIg = makeCandidate({
      id: 'experiment:x1',
      expected: { informationGain: 0.4, healthRisk: 0.1, privacyRisk: 0.01, rollbackConfidence: 0.998, durationMs: 800 },
    });
    expect(experimentUtility(unsafeHighIg)).toBeGreaterThan(experimentUtility(safeLowerIg));
    const picked = selector.select([unsafeHighIg, safeLowerIg], NOW, selectionBudget(3));
    expect(picked).not.toBeNull();
    expect(picked!.id).toBe('experiment:x1');
  });

  it('returns null when remaining budget is 0', () => {
    const x = makeCandidate();
    expect(selector.select([x], NOW, selectionBudget(0))).toBeNull();
  });

  it('returns null when epoch is stale', () => {
    const x = makeCandidate();
    const stale: CurrentEpochState = { ...NOW, navigationEpoch: 9 };
    expect(selector.select([x], stale, selectionBudget(3))).toBeNull();
  });

  it('returns null when none are feasible (privacy over ceiling)', () => {
    const x = makeCandidate({
      expected: { informationGain: 0.9, healthRisk: 0.1, privacyRisk: 0.5, rollbackConfidence: 0.999, durationMs: 400 },
    });
    expect(selector.select([x], NOW, selectionBudget(3))).toBeNull();
  });

  it('abstains rather than selecting a multi-variable bundle', () => {
    const x = makeCandidate({ controls: { oneVariable: false } });
    expect(selector.select([x], NOW, selectionBudget(3))).toBeNull();
  });
});

describe('validateCausalDecision (M3)', () => {
  const safe = makeCandidate({
    id: 'experiment:x1',
    hypothesisRef: 'hypothesis:h1',
    variable: 'restore_scroll',
    actionRefs: [STRATEGY_REF_ALLOWLIST.RESTORE_SCROLL],
  });
  const hyp = makeHypothesis({ id: 'hypothesis:h1', mechanismClass: 'SCROLL_LOCK_REACTION' });

  function packet(extra?: {
    experiments?: ExperimentCandidate[];
    hypotheses?: CausalHypothesis[];
    policy?: Partial<EvidencePacketV3['policy']>;
    now?: CurrentEpochState;
  }): EvidencePacketV3 {
    return buildMinimalPacket({
      now: extra?.now ?? NOW,
      hypotheses: extra?.hypotheses ?? [hyp],
      experiments: extra?.experiments ?? [safe],
      policy: extra?.policy,
    });
  }

  const goodDecision = wellFormedExperiment('experiment:x1', 'hypothesis:h1');
  const goodPacket = packet();

  it('accepts a well-formed EXPERIMENT that exists in the packet and matches epoch', () => {
    const result = validateCausalDecision(goodPacket, goodDecision, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.decision).toBe('EXPERIMENT');
      if (result.decision.decision === 'EXPERIMENT') {
        expect(result.decision.experimentRef).toBe('experiment:x1');
      }
    }
  });

  it('accepts ABSTAIN', () => {
    const decision: CausalPlannerDecisionV1 = {
      schemaVersion: 'causal-plan-1',
      decision: 'ABSTAIN',
      reasonCode: 'NO_VALID_EXPERIMENT',
      confidence: 0.9,
    };
    const result = validateCausalDecision(goodPacket, decision, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decision.decision).toBe('ABSTAIN');
  });

  it('accepts PROMOTE_RECIPE only when promotionGatePass is true', () => {
    const decision: CausalPlannerDecisionV1 = {
      schemaVersion: 'causal-plan-1',
      decision: 'PROMOTE_RECIPE',
      hypothesisRef: 'hypothesis:h1',
      reasonCode: 'HYPOTHESIS_CONFIRMED',
      confidence: 0.95,
    };
    expect(validateCausalDecision(goodPacket, decision, NOW).ok).toBe(false);
    const passed = validateCausalDecision(goodPacket, decision, NOW, { promotionGatePass: true });
    expect(passed.ok).toBe(true);
  });

  const unsafeCases: Array<{
    name: string;
    decision: unknown;
    packet?: EvidencePacketV3;
    now?: CurrentEpochState;
    opts?: { promotionGatePass?: boolean };
  }> = [
    { name: 'null decision', decision: null },
    { name: 'non-object decision', decision: 'EXPERIMENT' },
    { name: 'array decision', decision: [] },
    { name: 'truncated missing fields', decision: { decision: 'EXPERIMENT' } },
    {
      name: 'missing schemaVersion',
      decision: {
        decision: 'EXPERIMENT',
        experimentRef: 'experiment:x1',
        hypothesisRef: 'hypothesis:h1',
        reasonCode: 'MAX_INFORMATION_GAIN_SAFE',
        confidence: 0.7,
      },
    },
    {
      name: 'wrong schemaVersion',
      decision: { ...goodDecision, schemaVersion: 'causal-plan-99' },
    },
    {
      name: 'unknown decision verb',
      decision: { ...goodDecision, decision: 'ADAPT' },
    },
    {
      name: 'missing confidence',
      decision: {
        schemaVersion: 'causal-plan-1',
        decision: 'EXPERIMENT',
        experimentRef: 'experiment:x1',
        hypothesisRef: 'hypothesis:h1',
        reasonCode: 'MAX_INFORMATION_GAIN_SAFE',
      },
    },
    {
      name: 'NaN confidence',
      decision: { ...goodDecision, confidence: Number.NaN },
    },
    {
      name: 'Infinity confidence',
      decision: { ...goodDecision, confidence: Number.POSITIVE_INFINITY },
    },
    {
      name: 'confidence out of bounds',
      decision: { ...goodDecision, confidence: 1.5 },
    },
    {
      name: 'unknown reasonCode',
      decision: { ...goodDecision, reasonCode: 'BECAUSE_THE_PAGE_SAID_SO' },
    },
    {
      name: 'extra property',
      decision: { ...goodDecision, extraField: true },
    },
    {
      name: 'invented selector string',
      decision: { ...goodDecision, selector: '#paywall-gate' },
    },
    {
      name: 'invented actions expansion',
      decision: { ...goodDecision, actions: [{ type: 'DOM_REMOVE_OVERLAY', selector: '.ad' }] },
    },
    {
      name: 'invented css expansion',
      decision: { ...goodDecision, css: 'body{display:none}' },
    },
    {
      name: 'invented javascript expansion',
      decision: { ...goodDecision, javascript: 'document.cookie=""' },
    },
    {
      name: 'invented url expansion',
      decision: { ...goodDecision, url: 'https://tracker.example/allow' },
    },
    {
      name: 'unknown experimentRef',
      decision: wellFormedExperiment('experiment:x99', 'hypothesis:h1'),
    },
    {
      name: 'unknown hypothesisRef',
      decision: wellFormedExperiment('experiment:x1', 'hypothesis:h99'),
    },
    {
      name: 'malformed experimentRef',
      decision: { ...goodDecision, experimentRef: 'experiment:invented' },
    },
    {
      name: 'epoch mismatch',
      decision: goodDecision,
      now: { ...NOW, navigationEpoch: 8 },
    },
    {
      name: 'document mismatch',
      decision: goodDecision,
      now: { ...NOW, documentId: 'doc-other' },
    },
    {
      name: 'tab mismatch',
      decision: goodDecision,
      now: { ...NOW, tabId: 7 },
    },
    {
      name: 'remainingInterventions=0',
      decision: goodDecision,
      packet: packet({ policy: { remainingInterventions: 0 } }),
    },
    {
      name: 'privacyRisk above ceiling',
      decision: wellFormedExperiment('experiment:x2', 'hypothesis:h1'),
      packet: packet({
        experiments: [
          makeCandidate({
            id: 'experiment:x2',
            expected: { privacyRisk: 0.8, healthRisk: 0.05, informationGain: 0.99, rollbackConfidence: 0.999, durationMs: 100 },
          }),
        ],
      }),
    },
    {
      name: 'healthRisk above ceiling',
      decision: wellFormedExperiment('experiment:x3', 'hypothesis:h1'),
      packet: packet({
        experiments: [
          makeCandidate({
            id: 'experiment:x3',
            expected: { healthRisk: 0.9, privacyRisk: 0.01, informationGain: 0.99, rollbackConfidence: 0.999, durationMs: 100 },
          }),
        ],
      }),
    },
    {
      name: 'rollbackConfidence below min',
      decision: wellFormedExperiment('experiment:x4', 'hypothesis:h1'),
      packet: packet({
        experiments: [
          makeCandidate({
            id: 'experiment:x4',
            expected: { rollbackConfidence: 0.5, healthRisk: 0.05, privacyRisk: 0.01, informationGain: 0.4, durationMs: 800 },
          }),
        ],
      }),
    },
    {
      name: 'oneVariable=false',
      decision: wellFormedExperiment('experiment:x5', 'hypothesis:h1'),
      packet: packet({
        experiments: [makeCandidate({ id: 'experiment:x5', controls: { oneVariable: false } })],
      }),
    },
    {
      name: 'PROMOTE_RECIPE without promotionGatePass',
      decision: {
        schemaVersion: 'causal-plan-1',
        decision: 'PROMOTE_RECIPE',
        hypothesisRef: 'hypothesis:h1',
        reasonCode: 'HYPOTHESIS_CONFIRMED',
        confidence: 0.95,
      },
    },
    {
      name: 'PROMOTE_RECIPE with promotionGatePass false',
      decision: {
        schemaVersion: 'causal-plan-1',
        decision: 'PROMOTE_RECIPE',
        hypothesisRef: 'hypothesis:h1',
        reasonCode: 'HYPOTHESIS_CONFIRMED',
        confidence: 0.95,
      },
      opts: { promotionGatePass: false },
    },
    {
      name: 'PROMOTE_RECIPE unknown hypothesisRef',
      decision: {
        schemaVersion: 'causal-plan-1',
        decision: 'PROMOTE_RECIPE',
        hypothesisRef: 'hypothesis:h77',
        reasonCode: 'HYPOTHESIS_CONFIRMED',
        confidence: 0.95,
      },
      opts: { promotionGatePass: true },
    },
    {
      name: 'invented selector as experimentRef',
      decision: { ...goodDecision, experimentRef: '.ad-paywall' },
    },
    {
      name: 'EXPERIMENT missing experimentRef',
      decision: {
        schemaVersion: 'causal-plan-1',
        decision: 'EXPERIMENT',
        hypothesisRef: 'hypothesis:h1',
        reasonCode: 'MAX_INFORMATION_GAIN_SAFE',
        confidence: 0.7,
      },
    },
    {
      name: 'invalid expectedOutcome',
      decision: { ...goodDecision, expectedOutcome: 'PROFIT' },
    },
  ];

  it('rejects 100% of malformed/unsafe decisions', () => {
    const results = unsafeCases.map((c) => {
      const result = validateCausalDecision(c.packet ?? goodPacket, c.decision, c.now ?? NOW, c.opts);
      return { name: c.name, ok: result.ok, reason: result.ok ? '' : result.reason };
    });
    const accepted = results.filter((r) => r.ok);
    expect(accepted).toEqual([]);
    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(unsafeCases.length).toBe(results.length);
    expect(unsafeCases.length).toBeGreaterThanOrEqual(30);
  });
});
