/**
 * Phase 3 M2 — EventGraph helpers: node/edge mutation, prune, lag windows.
 * Hypothesis types live in events.ts (M1); do not duplicate them here.
 */

import {
  CausalDocumentKey,
  EventEdge,
  EventGraph,
  EventNode,
  ExperimentBudget,
  OpaqueRef,
  timestampDeltaMs,
} from './events';

export const MAX_GRAPH_NODES = 256;

export const DEFAULT_EXPERIMENT_BUDGET: ExperimentBudget = {
  maxPerDocumentEpoch: 3,
  maxReloadingExperiments: 1,
  maxCumulativeWaitMs: 8000,
  maxHealthRisk: 0.2,
  maxPrivacyRisk: 0.1,
  minRollbackConfidence: 0.995,
};

/** Spec §9.1 — candidate generators, not proof. */
export const DEFAULT_LAG_WINDOWS = {
  blockedRequestToAntiBlockOverlay: { min: 0, max: 3000 },
  baitStateChangeToReactionUi: { min: 0, max: 2000 },
  domRemovalToReinsertion: { min: 0, max: 1500 },
  scriptCompleteToScrollLock: { min: 0, max: 1000 },
  recipeReplayToHealthDeterioration: { min: 0, max: 5000 },
  serviceWorkerCacheToContentMismatch: { min: 0, max: 10000 },
} as const;

export type LagWindow = { min: number; max: number };

export type GraphRejectReason =
  | 'TAB_MISMATCH'
  | 'EPOCH_MISMATCH'
  | 'DOCUMENT_MISMATCH'
  | 'ORIGIN_MISMATCH'
  | 'FRAME_MISMATCH';

export type GraphMutationResult = { ok: true } | { ok: false; reason: GraphRejectReason };

const BENIGN_CLASSES = new Set([
  'consent',
  'login',
  'newsletter',
  'paywall',
  'video-controls',
  'sticky-nav',
  'cookie',
  'gdpr',
  'age-gate',
]);

export function serializeCausalKey(key: CausalDocumentKey): string {
  return `${key.tabId}\u0000${key.navigationEpoch}\u0000${key.documentId}\u0000${key.frameId}`;
}

export function createGraphId(key: CausalDocumentKey): string {
  return `graph:${key.tabId}:${key.navigationEpoch}:${key.documentId}:${key.frameId}`;
}

export function createEmptyGraph(
  key: CausalDocumentKey,
  originHash: string,
  createdWallMs: number = Date.now()
): EventGraph {
  return {
    graphVersion: '3.0',
    graphId: createGraphId(key),
    scope: {
      originHash,
      tabId: key.tabId,
      navigationEpoch: key.navigationEpoch,
      documentId: key.documentId,
      createdWallMs,
    },
    nodes: [],
    edges: [],
    hypotheses: [],
    experiments: [],
    budgets: { ...DEFAULT_EXPERIMENT_BUDGET },
  };
}

function isEventRef(ref: EventNode['id'] | OpaqueRef): ref is EventNode['id'] {
  return ref.startsWith('event:');
}

/**
 * Tiny pure benign-modal classifier. Never adapt on these outcomes.
 */
export function isBenignOutcome(node: EventNode): boolean {
  const cls = node.features.benignClass;
  const role = node.features.role;
  if (typeof cls === 'string' && BENIGN_CLASSES.has(cls)) return true;
  if (typeof role === 'string' && BENIGN_CLASSES.has(role)) return true;
  return false;
}

/**
 * Same clock domain only. Returns null when domains differ — never subtract.
 * True when `a` occurs at or before `b` (lag 0 is a valid candidate).
 */
export function temporalPrecedes(a: EventNode, b: EventNode): boolean | null {
  if (a.timestamp.domain !== b.timestamp.domain) return null;
  return a.timestamp.value <= b.timestamp.value;
}

/** Outcome minus cause, or null across clock domains. */
export function lagMs(cause: EventNode, outcome: EventNode): number | null {
  return timestampDeltaMs(outcome.timestamp, cause.timestamp);
}

export function withinLagWindow(
  cause: EventNode,
  outcome: EventNode,
  window: LagWindow
): boolean {
  const precedes = temporalPrecedes(cause, outcome);
  if (precedes !== true) return false;
  const lag = lagMs(cause, outcome);
  if (lag === null) return false;
  return lag >= window.min && lag <= window.max;
}

export function addNode(graph: EventGraph, node: EventNode): GraphMutationResult {
  if (node.scope.tabId !== graph.scope.tabId) {
    return { ok: false, reason: 'TAB_MISMATCH' };
  }
  if (node.scope.navigationEpoch !== graph.scope.navigationEpoch) {
    return { ok: false, reason: 'EPOCH_MISMATCH' };
  }
  if (node.scope.documentId !== graph.scope.documentId) {
    return { ok: false, reason: 'DOCUMENT_MISMATCH' };
  }
  if (node.scope.originHash !== graph.scope.originHash) {
    return { ok: false, reason: 'ORIGIN_MISMATCH' };
  }
  const existingFrame = graph.nodes[0]?.scope.frameId;
  if (existingFrame !== undefined && existingFrame !== node.scope.frameId) {
    return { ok: false, reason: 'FRAME_MISMATCH' };
  }
  if (graph.nodes.some((n) => n.id === node.id)) {
    return { ok: true };
  }
  graph.nodes.push(node);
  return { ok: true };
}

export function addEdge(graph: EventGraph, edge: EventEdge): GraphMutationResult {
  const duplicate = graph.edges.some(
    (e) =>
      e.id === edge.id ||
      (e.from === edge.from && e.to === edge.to && e.relation === edge.relation)
  );
  if (!duplicate) {
    graph.edges.push(edge);
  }
  return { ok: true };
}

/**
 * Drop oldest nodes (insertion order) when over cap.
 * TEMPORAL_CANDIDATE edges whose endpoints were pruned are removed;
 * any dangling edge with a pruned event endpoint is also dropped.
 */
export function pruneGraph(graph: EventGraph, maxNodes: number): EventGraph {
  if (graph.nodes.length <= maxNodes) return graph;
  const overflow = graph.nodes.length - maxNodes;
  const removed = graph.nodes.slice(0, overflow);
  const removedIds = new Set(removed.map((n) => n.id));
  graph.nodes = graph.nodes.slice(overflow);
  graph.edges = graph.edges.filter((edge) => {
    const fromGone = isEventRef(edge.from) && removedIds.has(edge.from);
    const toGone = isEventRef(edge.to) && removedIds.has(edge.to);
    if (!fromGone && !toGone) return true;
    if (edge.status === 'TEMPORAL_CANDIDATE') return false;
    return false;
  });
  return graph;
}
