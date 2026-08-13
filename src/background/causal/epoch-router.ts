import { NavigationRegistry } from '../../core/navigation/registry';
import { CausalDocumentKey, EventNode } from '../../shared/causal/events';

export type RouteDecision =
  | { ok: true; key: CausalDocumentKey }
  | {
      ok: false;
      reason:
        | 'NO_EPOCH'
        | 'STALE_EPOCH'
        | 'TAB_MISMATCH'
        | 'DOCUMENT_MISMATCH'
        | 'FRAME_MISMATCH'
        | 'CROSS_TAB';
    };

/**
 * M1 gate: drop events so no event from tab A / old epoch / old document
 * mutates tab B / new epoch. Never uses processId.
 */
export class EpochRouter {
  constructor(private registry: NavigationRegistry) {}

  route(incoming: CausalDocumentKey): RouteDecision {
    for (const tabId of this.registry.getActiveTabIds()) {
      if (tabId === incoming.tabId) continue;
      const other = this.registry.getCausalKey(tabId, incoming.frameId);
      if (
        other &&
        other.documentId === incoming.documentId &&
        other.navigationEpoch === incoming.navigationEpoch
      ) {
        return { ok: false, reason: 'CROSS_TAB' };
      }
    }

    const live = this.registry.getCausalKey(incoming.tabId, incoming.frameId);
    if (!live) {
      const main = this.registry.getCausalKey(incoming.tabId, 0);
      if (main && main.frameId !== incoming.frameId) {
        return { ok: false, reason: 'FRAME_MISMATCH' };
      }
      return { ok: false, reason: 'NO_EPOCH' };
    }

    if (live.tabId !== incoming.tabId) {
      return { ok: false, reason: 'TAB_MISMATCH' };
    }
    if (live.frameId !== incoming.frameId) {
      return { ok: false, reason: 'FRAME_MISMATCH' };
    }
    if (live.documentId !== incoming.documentId) {
      return { ok: false, reason: 'DOCUMENT_MISMATCH' };
    }
    if (live.navigationEpoch !== incoming.navigationEpoch) {
      return { ok: false, reason: 'STALE_EPOCH' };
    }

    return { ok: true, key: live };
  }

  /** Accept an EventNode only if its scope matches the live epoch for that tab/frame. */
  accept(node: EventNode): RouteDecision {
    return this.route({
      tabId: node.scope.tabId,
      navigationEpoch: node.scope.navigationEpoch,
      documentId: node.scope.documentId,
      frameId: node.scope.frameId,
    });
  }
}
