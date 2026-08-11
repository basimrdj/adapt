import { DnrIdAllocator } from './ids';

export interface ReconciliationResult {
  orphanedSessionRulesRemoved: number[];
  orphanedDynamicRulesRemoved: number[];
  reconciledSuccessfully: boolean;
  errors: string[];
}

export class DnrReconciler {
  /**
   * Reconciles physical rules present in Chromium DNR with our logical allocations.
   * Cleans up orphaned session rules left over from interrupted experiments or crashed workers.
   */
  public async reconcile(
    idAllocator: DnrIdAllocator,
    knownActiveOwnerIds: Set<string>,
    dnrBackend: {
      getDynamicRules: () => Promise<chrome.declarativeNetRequest.Rule[]>;
      getSessionRules: () => Promise<chrome.declarativeNetRequest.Rule[]>;
      updateDynamicRules: (options: { removeRuleIds?: number[] }) => Promise<void>;
      updateSessionRules: (options: { removeRuleIds?: number[] }) => Promise<void>;
    }
  ): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
      orphanedSessionRulesRemoved: [],
      orphanedDynamicRulesRemoved: [],
      reconciledSuccessfully: true,
      errors: [],
    };

    try {
      // 1. Reconcile Session Rules
      const actualSessionRules = await dnrBackend.getSessionRules();
      const sessionAllocations = idAllocator.getAllAllocations().filter((a) => a.band.startsWith('SESSION_'));

      const sessionToRemove: number[] = [];

      for (const rule of actualSessionRules) {
        const alloc = sessionAllocations.find((a) => a.id === rule.id);
        // If unallocated or owner is no longer an active transaction, remove
        if (!alloc || !knownActiveOwnerIds.has(alloc.ownerId)) {
          sessionToRemove.push(rule.id);
        }
      }

      if (sessionToRemove.length > 0) {
        await dnrBackend.updateSessionRules({ removeRuleIds: sessionToRemove });
        sessionToRemove.forEach((id) => idAllocator.release(id));
        result.orphanedSessionRulesRemoved = sessionToRemove;
      }

      // 2. Reconcile Dynamic Rules
      const actualDynamicRules = await dnrBackend.getDynamicRules();
      const dynamicAllocations = idAllocator.getAllAllocations().filter((a) => a.band.startsWith('DYNAMIC_'));

      const dynamicToRemove: number[] = [];

      for (const rule of actualDynamicRules) {
        const alloc = dynamicAllocations.find((a) => a.id === rule.id);
        if (!alloc || !knownActiveOwnerIds.has(alloc.ownerId)) {
          dynamicToRemove.push(rule.id);
        }
      }

      if (dynamicToRemove.length > 0) {
        await dnrBackend.updateDynamicRules({ removeRuleIds: dynamicToRemove });
        dynamicToRemove.forEach((id) => idAllocator.release(id));
        result.orphanedDynamicRulesRemoved = dynamicToRemove;
      }
    } catch (err: unknown) {
      result.reconciledSuccessfully = false;
      result.errors.push(err instanceof Error ? err.message : String(err));
    }

    return result;
  }
}
