import { describe, it, expect } from 'vitest';
import { DnrIdAllocator } from '../../src/core/dnr/ids';
import { DnrReconciler } from '../../src/core/dnr/reconcile';

describe('DnrReconciler', () => {
  it('cleans up orphaned session rules on service worker wake', async () => {
    const allocator = new DnrIdAllocator();
    const sessionAlloc1 = allocator.allocate('SESSION_SAFE', 'active_tx_1');
    const sessionAlloc2 = allocator.allocate('SESSION_SAFE', 'dead_tx_2');

    const mockRules: chrome.declarativeNetRequest.Rule[] = [
      { id: sessionAlloc1, priority: 1, action: { type: 'block' as any }, condition: {} },
      { id: sessionAlloc2, priority: 1, action: { type: 'block' as any }, condition: {} },
      { id: 9999999, priority: 1, action: { type: 'block' as any }, condition: {} }, // unallocated orphan
    ];

    const removedSessionIds: number[] = [];

    const mockBackend = {
      getDynamicRules: async () => [],
      getSessionRules: async () => mockRules,
      updateDynamicRules: async () => {},
      updateSessionRules: async (opts: { removeRuleIds?: number[] }) => {
        if (opts.removeRuleIds) removedSessionIds.push(...opts.removeRuleIds);
      },
    };

    const reconciler = new DnrReconciler();
    const activeOwners = new Set(['active_tx_1']);

    const result = await reconciler.reconcile(allocator, activeOwners, mockBackend);
    expect(result.reconciledSuccessfully).toBe(true);
    expect(result.orphanedSessionRulesRemoved).toContain(sessionAlloc2);
    expect(result.orphanedSessionRulesRemoved).toContain(9999999);
    expect(result.orphanedSessionRulesRemoved).not.toContain(sessionAlloc1);
  });
});
