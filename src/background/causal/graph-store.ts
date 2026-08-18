/**
 * Phase 3 M2 — EventGraph store.
 *
 * Keyed by CausalDocumentKey (tabId + navigationEpoch + documentId + frameId).
 * Never merge graphs across tabs, documents, or epochs.
 *
 * Persistence is coordinated by CausalSessionStateRepository using
 * chrome.storage.session so service-worker suspension does not erase evidence.
 * When a document epoch ends, discard the graph; only compact recipe-level
 * learnings persist (none in M2).
 */

import {
  CausalDocumentKey,
  EventGraph,
  EventNode,
  causalKeyFromNode,
} from '../../shared/causal/events';
import {
  MAX_GRAPH_NODES,
  addNode,
  createEmptyGraph,
  pruneGraph,
  serializeCausalKey,
  type GraphRejectReason,
} from '../../shared/causal/graph';
import { EpochRouter } from './epoch-router';

export type GraphAppendReason =
  | GraphRejectReason
  | 'NO_GRAPH'
  | 'STALE_EPOCH'
  | 'NO_EPOCH'
  | 'CROSS_TAB';

export type GraphAppendResult = { ok: true } | { ok: false; reason: GraphAppendReason };

interface GraphSlot {
  key: CausalDocumentKey;
  graph: EventGraph;
  lastTouchedWallMs: number;
}

/**
 * Hard bound on live graph slots. The full slot set is serialized into
 * chrome.storage.session on every persist — without a cap, a long session of
 * tab/frame churn grows the snapshot into the 10MB session quota and every
 * write starts failing. 128 slots × the per-graph node cap stays safely inside
 * the quota while covering extreme tab floods.
 */
export const MAX_GRAPH_SLOTS = 128;

export class EventGraphStore {
  private readonly slots = new Map<string, GraphSlot>();

  constructor(private readonly router?: EpochRouter) {}

  getOrCreate(scope: CausalDocumentKey, originHash: string): EventGraph {
    const id = serializeCausalKey(scope);
    const existing = this.slots.get(id);
    if (existing) {
      existing.lastTouchedWallMs = Date.now();
      return existing.graph;
    }
    const graph = createEmptyGraph(scope, originHash);
    this.slots.set(id, { key: { ...scope }, graph, lastTouchedWallMs: Date.now() });
    this.evictOverflow(id);
    return graph;
  }

  /** LRU-evict slots beyond the cap; the just-created slot is never evicted. */
  private evictOverflow(protectedId: string): void {
    while (this.slots.size > MAX_GRAPH_SLOTS) {
      let oldestId: string | undefined;
      let oldestTouched = Infinity;
      for (const [id, slot] of this.slots) {
        if (id === protectedId) continue;
        if (slot.lastTouchedWallMs < oldestTouched) {
          oldestTouched = slot.lastTouchedWallMs;
          oldestId = id;
        }
      }
      if (oldestId === undefined) return;
      this.slots.delete(oldestId);
    }
  }

  get(key: CausalDocumentKey): EventGraph | undefined {
    const slot = this.slots.get(serializeCausalKey(key));
    if (slot) slot.lastTouchedWallMs = Date.now();
    return slot?.graph;
  }

  getAll(): EventGraph[] {
    return Array.from(this.slots.values()).map((s) => s.graph);
  }

  hydrate(graphs: EventGraph[]): void {
    this.slots.clear();
    // Newest first, then capped: a snapshot that already exceeded the bound (or a
    // corrupted/oversized payload) hydrates only its most recent graphs.
    const ordered = [...graphs].reverse();
    for (const graph of ordered) {
      if (this.slots.size >= MAX_GRAPH_SLOTS) break;
      if (!graph || graph.graphVersion !== '3.0' || !graph.scope) continue;
      const frameId = graph.nodes[0]?.scope.frameId ?? 0;
      const key: CausalDocumentKey = {
        tabId: graph.scope.tabId,
        navigationEpoch: graph.scope.navigationEpoch,
        documentId: graph.scope.documentId,
        frameId,
      };
      this.slots.set(serializeCausalKey(key), { key, graph, lastTouchedWallMs: Date.now() });
    }
  }

  /**
   * Append `node` into the graph for its CausalDocumentKey.
   * Rejects if the node does not match an existing graph's scope (epoch isolation).
   * Call getOrCreate first for the live key.
   */
  append(node: EventNode): GraphAppendResult {
    if (this.router) {
      const routed = this.router.accept(node);
      if (!routed.ok) {
        return { ok: false, reason: routed.reason };
      }
    }

    const key = causalKeyFromNode(node);
    const exact = this.slots.get(serializeCausalKey(key));
    if (exact) {
      exact.lastTouchedWallMs = Date.now();
      const added = addNode(exact.graph, node);
      if (!added.ok) return added;
      pruneGraph(exact.graph, MAX_GRAPH_NODES);
      return { ok: true };
    }

    for (const slot of this.slots.values()) {
      if (slot.key.tabId === node.scope.tabId && slot.key.frameId === node.scope.frameId) {
        if (slot.key.navigationEpoch !== node.scope.navigationEpoch) {
          return { ok: false, reason: 'EPOCH_MISMATCH' };
        }
        if (slot.key.documentId !== node.scope.documentId) {
          return { ok: false, reason: 'DOCUMENT_MISMATCH' };
        }
      }
    }

    for (const slot of this.slots.values()) {
      if (slot.key.tabId !== node.scope.tabId) {
        return { ok: false, reason: 'TAB_MISMATCH' };
      }
    }

    return { ok: false, reason: 'NO_GRAPH' };
  }

  /** Drop the graph when the document epoch ends. */
  discard(key: CausalDocumentKey): void {
    this.slots.delete(serializeCausalKey(key));
  }
}
