import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { EventGraphStore } from '../../src/background/causal/graph-store';
import {
  CandidateGenerator,
  MAX_ACTIVE_HYPOTHESES,
  TEMPORAL_CANDIDATE_PRIOR,
} from '../../src/background/causal/candidate-generator';
import {
  MAX_GRAPH_NODES,
  addEdge,
  addNode,
  createEmptyGraph,
  isBenignOutcome,
  pruneGraph,
  temporalPrecedes,
  withinLagWindow,
  DEFAULT_LAG_WINDOWS,
} from '../../src/shared/causal/graph';
import {
  CausalDocumentKey,
  CausalHypothesis,
  EventEdge,
  EventKind,
  EventNode,
  EventProvenance,
  OpaqueRef,
  causalKeyFromNode,
  timestampDeltaMs,
} from '../../src/shared/causal/events';

const ORIGIN_HASH = '100680ad546ce6a577f42f52df33b4cfdca756859e664b8d7de329b150d09ce9';
const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/causal');

interface GroundTruthPair {
  mechanismClass: CausalHypothesis['mechanismClass'];
  causeEventId: EventNode['id'];
  outcomeEventId: EventNode['id'];
}

interface CausalFixture {
  id: string;
  nodes: EventNode[];
  groundTruth: GroundTruthPair[] | { none: true; reason: string };
}

function loadFixture(name: string): CausalFixture {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
  return raw as CausalFixture;
}

function isNoneTruth(
  gt: CausalFixture['groundTruth']
): gt is { none: true; reason: string } {
  return !Array.isArray(gt) && gt.none === true;
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

function replay(fixture: CausalFixture): {
  store: EventGraphStore;
  hypotheses: CausalHypothesis[];
} {
  const store = new EventGraphStore();
  for (const node of fixture.nodes) {
    const key = causalKeyFromNode(node);
    store.getOrCreate(key, node.scope.originHash);
    store.append(node);
  }
  const generator = new CandidateGenerator();
  const hypotheses: CausalHypothesis[] = [];
  for (const graph of store.getAll()) {
    hypotheses.push(...generator.update(graph));
  }
  return { store, hypotheses };
}

function recallsPair(hypotheses: CausalHypothesis[], pair: GroundTruthPair): boolean {
  return hypotheses.some(
    (h) =>
      h.mechanismClass === pair.mechanismClass &&
      (h.causeRefs.includes(pair.causeEventId) || h.createdFrom.includes(pair.causeEventId)) &&
      h.createdFrom.includes(pair.outcomeEventId)
  );
}

const ANTI_BLOCK_FIXTURES = [
  'blocked-request-overlay.json',
  'bait-then-overlay.json',
  'overlay-reinsertion.json',
  'script-scroll-lock.json',
  'mixed-trace.json',
] as const;

describe('EventGraph store (M2)', () => {
  const key: CausalDocumentKey = {
    tabId: 1,
    navigationEpoch: 1,
    documentId: 'doc-a',
    frameId: 0,
  };

  it('rejects append from the wrong epoch', () => {
    const store = new EventGraphStore();
    store.getOrCreate(key, ORIGIN_HASH);
    const stale = makeNode({
      id: 'event:stale',
      kind: 'OVERLAY_APPEARED',
      t: 1,
      navigationEpoch: 2,
      documentId: 'doc-a',
    });
    const result = store.append(stale);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EPOCH_MISMATCH');
  });

  it('rejects append from the wrong tab', () => {
    const store = new EventGraphStore();
    store.getOrCreate(key, ORIGIN_HASH);
    const otherTab = makeNode({
      id: 'event:tab2',
      kind: 'OVERLAY_APPEARED',
      t: 1,
      tabId: 2,
      documentId: 'doc-b',
    });
    const result = store.append(otherTab);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('TAB_MISMATCH');
  });

  it('addNode rejects scope mismatches against graph.scope', () => {
    const graph = createEmptyGraph(key, ORIGIN_HASH);
    const wrongEpoch = makeNode({
      id: 'event:e2',
      kind: 'REQUEST_ERROR',
      t: 10,
      navigationEpoch: 9,
      documentId: 'doc-a',
    });
    const epochResult = addNode(graph, wrongEpoch);
    expect(epochResult.ok).toBe(false);
    if (!epochResult.ok) expect(epochResult.reason).toBe('EPOCH_MISMATCH');

    const wrongTab = makeNode({
      id: 'event:t2',
      kind: 'REQUEST_ERROR',
      t: 10,
      tabId: 2,
      documentId: 'doc-a',
    });
    const tabResult = addNode(graph, wrongTab);
    expect(tabResult.ok).toBe(false);
    if (!tabResult.ok) expect(tabResult.reason).toBe('TAB_MISMATCH');
  });

  it('discards the graph on epoch end; a new epoch gets an empty graph', () => {
    const store = new EventGraphStore();
    const graph1 = store.getOrCreate(key, ORIGIN_HASH);
    const n1 = makeNode({
      id: 'event:n1',
      kind: 'REQUEST_ERROR',
      t: 1,
      documentId: 'doc-a',
      provenance: 'webRequest',
    });
    expect(store.append(n1).ok).toBe(true);
    expect(graph1.nodes).toHaveLength(1);

    store.discard(key);
    expect(store.get(key)).toBeUndefined();

    const next: CausalDocumentKey = {
      tabId: 1,
      navigationEpoch: 2,
      documentId: 'doc-b',
      frameId: 0,
    };
    const graph2 = store.getOrCreate(next, ORIGIN_HASH);
    expect(graph2.nodes).toHaveLength(0);
    expect(graph2.hypotheses).toHaveLength(0);
    expect(graph2.graphId).not.toBe(graph1.graphId);
  });

  it('prunes oldest nodes when over the cap and drops TEMPORAL_CANDIDATE edges', () => {
    const graph = createEmptyGraph(key, ORIGIN_HASH);
    for (let i = 0; i < MAX_GRAPH_NODES + 4; i++) {
      const n = makeNode({
        id: `event:p${i}`,
        kind: 'REQUEST_START',
        t: i,
        documentId: 'doc-a',
        provenance: 'webRequest',
      });
      expect(addNode(graph, n).ok).toBe(true);
    }
    const first = graph.nodes[0];
    const second = graph.nodes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const edge: EventEdge = {
      id: 'edge:old',
      from: first!.id,
      to: second!.id,
      relation: 'PRECEDES',
      status: 'TEMPORAL_CANDIDATE',
      support: { observationalN: 1, interventionN: 0, positiveN: 0, negativeN: 0 },
      confounders: [],
      lastUpdatedWallMs: 0,
    };
    addEdge(graph, edge);
    expect(graph.nodes.length).toBe(MAX_GRAPH_NODES + 4);

    pruneGraph(graph, MAX_GRAPH_NODES);
    expect(graph.nodes).toHaveLength(MAX_GRAPH_NODES);
    expect(graph.nodes[0]?.id).toBe('event:p4');
    expect(graph.nodes.some((n) => n.id === 'event:p0')).toBe(false);
    expect(graph.edges.some((e) => e.id === 'edge:old')).toBe(false);
  });

  it('store.append prunes to the cap', () => {
    const store = new EventGraphStore();
    store.getOrCreate(key, ORIGIN_HASH);
    for (let i = 0; i < MAX_GRAPH_NODES + 2; i++) {
      const result = store.append(
        makeNode({
          id: `event:s${i}`,
          kind: 'REQUEST_START',
          t: i,
          documentId: 'doc-a',
          provenance: 'webRequest',
        })
      );
      expect(result.ok).toBe(true);
    }
    expect(store.get(key)?.nodes).toHaveLength(MAX_GRAPH_NODES);
  });
});

describe('clock domains', () => {
  it('timestampDeltaMs across domains is null so those pairs are not candidates', () => {
    const cause = makeNode({
      id: 'event:x-cause',
      kind: 'REQUEST_ERROR',
      t: 10000,
      provenance: 'webRequest',
      features: { blocked: true, error: 'net::ERR_BLOCKED_BY_CLIENT' },
    });
    const outcome = makeNode({
      id: 'event:x-overlay',
      kind: 'OVERLAY_APPEARED',
      t: 10800,
      domain: 'document.performance_ms',
    });
    expect(timestampDeltaMs(cause.timestamp, outcome.timestamp)).toBeNull();
    expect(temporalPrecedes(cause, outcome)).toBeNull();
    expect(
      withinLagWindow(cause, outcome, DEFAULT_LAG_WINDOWS.blockedRequestToAntiBlockOverlay)
    ).toBe(false);

    const graph = createEmptyGraph(causalKeyFromNode(cause), ORIGIN_HASH);
    expect(addNode(graph, cause).ok).toBe(true);
    expect(addNode(graph, outcome).ok).toBe(true);
    const hyps = new CandidateGenerator().update(graph);
    expect(hyps).toHaveLength(0);
  });
});

describe('CandidateGenerator fixture replay (M2)', () => {
  it('replays every fixture through CandidateGenerator', () => {
    const names = [
      'blocked-request-overlay.json',
      'bait-then-overlay.json',
      'overlay-reinsertion.json',
      'script-scroll-lock.json',
      'benign-consent.json',
      'benign-login.json',
      'cross-epoch-poison.json',
      'cross-tab-poison.json',
      'outside-window.json',
      'mixed-trace.json',
    ];
    for (const name of names) {
      const fixture = loadFixture(name);
      const { hypotheses } = replay(fixture);
      expect(Array.isArray(hypotheses)).toBe(true);
    }
  });

  it('recalls ground-truth pairs at >= 95% on anti-block fixtures (1-4, 10)', () => {
    let truth = 0;
    let hits = 0;
    const missed: string[] = [];
    for (const name of ANTI_BLOCK_FIXTURES) {
      const fixture = loadFixture(name);
      const { hypotheses } = replay(fixture);
      expect(isNoneTruth(fixture.groundTruth)).toBe(false);
      if (isNoneTruth(fixture.groundTruth)) continue;
      for (const pair of fixture.groundTruth) {
        truth += 1;
        if (recallsPair(hypotheses, pair)) {
          hits += 1;
        } else {
          missed.push(`${fixture.id}:${pair.causeEventId}->${pair.outcomeEventId}`);
        }
      }
      for (const h of hypotheses) {
        expect(h.status).toBe('CANDIDATE');
        expect(h.prior).toBe(TEMPORAL_CANDIDATE_PRIOR);
        expect(h.posterior).toBe(h.prior);
        expect(h.confoundingRisk).toBe('MEDIUM');
      }
    }
    const recall = truth === 0 ? 0 : hits / truth;
    expect(missed).toEqual([]);
    expect(truth).toBeGreaterThanOrEqual(5);
    expect(recall).toBeGreaterThanOrEqual(0.95);
  });

  it('produces zero adaptation hypotheses on benign consent/login fixtures', () => {
    for (const name of ['benign-consent.json', 'benign-login.json'] as const) {
      const fixture = loadFixture(name);
      const { hypotheses } = replay(fixture);
      expect(hypotheses).toHaveLength(0);
      expect(hypotheses.some((h) => h.outcome === 'ANTI_BLOCK_REACTION')).toBe(false);
      const overlay = fixture.nodes.find((n) => n.kind === 'OVERLAY_APPEARED');
      expect(overlay).toBeDefined();
      expect(isBenignOutcome(overlay!)).toBe(true);
    }
  });

  it('creates zero hypotheses on cross-epoch and cross-tab poison fixtures', () => {
    for (const name of ['cross-epoch-poison.json', 'cross-tab-poison.json'] as const) {
      const fixture = loadFixture(name);
      const { hypotheses, store } = replay(fixture);
      expect(hypotheses).toHaveLength(0);
      expect(store.getAll().length).toBe(2);
    }
  });

  it('does not emit BLOCKED_RESOURCE_PROBE for a pair outside the lag window', () => {
    const fixture = loadFixture('outside-window.json');
    const { hypotheses } = replay(fixture);
    expect(
      hypotheses.some(
        (h) =>
          h.mechanismClass === 'BLOCKED_RESOURCE_PROBE' &&
          (h.causeRefs.includes('event:ow-cause') || h.createdFrom.includes('event:ow-cause')) &&
          h.createdFrom.includes('event:ow-overlay')
      )
    ).toBe(false);
    expect(hypotheses).toHaveLength(0);
  });

  it('mixed-trace recalls anti-block and skips the consent overlay', () => {
    const fixture = loadFixture('mixed-trace.json');
    const { hypotheses } = replay(fixture);
    expect(isNoneTruth(fixture.groundTruth)).toBe(false);
    if (isNoneTruth(fixture.groundTruth)) return;
    expect(recallsPair(hypotheses, fixture.groundTruth[0]!)).toBe(true);
    expect(hypotheses.some((h) => h.createdFrom.includes('event:mx-consent'))).toBe(false);
  });

  it('generator still refuses cross-epoch pairs even if stuffed into one node list', () => {
    const fixture = loadFixture('cross-epoch-poison.json');
    const first = fixture.nodes[0];
    expect(first).toBeDefined();
    const graph = createEmptyGraph(causalKeyFromNode(first!), first!.scope.originHash);
    graph.nodes = [...fixture.nodes];
    const hyps = new CandidateGenerator().update(graph);
    expect(hyps).toHaveLength(0);
  });

  it('caps active hypotheses per document epoch and merges duplicate mechanism+cause', () => {
    const key: CausalDocumentKey = {
      tabId: 1,
      navigationEpoch: 1,
      documentId: 'doc-cap',
      frameId: 0,
    };
    const graph = createEmptyGraph(key, ORIGIN_HASH);
    const cause = makeNode({
      id: 'event:dup-cause',
      kind: 'REQUEST_ERROR',
      t: 0,
      documentId: 'doc-cap',
      provenance: 'webRequest',
      features: { blocked: true },
      refs: ['request:r1'],
    });
    addNode(graph, cause);
    addNode(
      graph,
      makeNode({
        id: 'event:dup-o1',
        kind: 'OVERLAY_APPEARED',
        t: 100,
        documentId: 'doc-cap',
      })
    );
    addNode(
      graph,
      makeNode({
        id: 'event:dup-o2',
        kind: 'OVERLAY_APPEARED',
        t: 200,
        documentId: 'doc-cap',
      })
    );
    const merged = new CandidateGenerator().update(graph);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.mechanismClass).toBe('BLOCKED_RESOURCE_PROBE');
    expect(merged[0]?.createdFrom).toEqual(
      expect.arrayContaining(['event:dup-cause', 'event:dup-o1', 'event:dup-o2'])
    );

    const capGraph = createEmptyGraph(key, ORIGIN_HASH);
    for (let i = 0; i < MAX_ACTIVE_HYPOTHESES + 3; i++) {
      addNode(
        capGraph,
        makeNode({
          id: `event:c${i}`,
          kind: 'REQUEST_ERROR',
          t: i * 10,
          documentId: 'doc-cap',
          provenance: 'webRequest',
          features: { blocked: true },
          refs: [`request:r${i + 1}`],
        })
      );
      addNode(
        capGraph,
        makeNode({
          id: `event:o${i}`,
          kind: 'OVERLAY_APPEARED',
          t: i * 10 + 50,
          documentId: 'doc-cap',
        })
      );
    }
    const capped = new CandidateGenerator().update(capGraph);
    expect(capped.length).toBe(MAX_ACTIVE_HYPOTHESES);
  });
});
