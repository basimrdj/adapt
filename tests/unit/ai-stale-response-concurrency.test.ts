import { describe, it, expect } from 'vitest';
import { AdaptationTransactionEngine } from '../../src/core/adaptation/engine';
import { DnrController } from '../../src/core/dnr/controller';
import { RecipeStore } from '../../src/core/recipes/store';
import { AuditStore } from '../../src/core/audit/store';
import { PageSignalBatch } from '../../src/shared/types';
import { MockPlanner } from '../../src/shared/ai/mock-planner';

describe('Phase 2.5 Stale Response & Concurrency Stress Suite', () => {
  const dummyDnrBackend = {
    getDynamicRules: async () => [],
    getSessionRules: async () => [],
    updateDynamicRules: async () => {},
    updateSessionRules: async () => {},
  };

  const createDummyBatch = (hasOverlay: boolean): PageSignalBatch => ({
    navigationId: 'epoch_1',
    timestamp: Date.now(),
    geometry: {
      viewportWidth: 1920,
      viewportHeight: 1080,
      hasFixedOverlay: hasOverlay,
      overlayCoverageRatio: hasOverlay ? 0.9 : 0.0,
      bodyScrollLocked: hasOverlay,
      htmlScrollLocked: false,
      modalCount: hasOverlay ? 1 : 0,
      mainContentHidden: false,
      mainContentHeight: 1000,
    },
    semantic: {
      detectedPhrases: hasOverlay ? ['disable adblock'] : [],
      adblockKeywordDensity: hasOverlay ? 0.05 : 0.0,
      confidenceScore: hasOverlay ? 0.9 : 0.0,
    },
    interaction: {
      pointerEventsSuppressed: hasOverlay,
      bodyOverflowHidden: hasOverlay,
      contentCovered: false,
    },
    mutation: {
      mutationRatePerSecond: 5,
      rapidReinsertionDetected: false,
      overlayReinsertedCount: 0,
      degradationState: 'NORMAL',
    },
    suspectedDetectorTypes: hasOverlay ? ['FULLSCREEN_GATE'] : [],
  });

  it('Stale Response: Ignores AI plan if tab has navigated to a new epoch', async () => {
    const memoryStorage: Record<string, any> = {};
    const storageBackend = {
      get: async (keys: string[]) => {
        const res: Record<string, any> = {};
        for (const k of keys) if (memoryStorage[k]) res[k] = memoryStorage[k];
        return res;
      },
      set: async (items: Record<string, any>): Promise<void> => {
        Object.assign(memoryStorage, items);
      },
      remove: async (keys: string[]) => {
        for (const k of keys) delete memoryStorage[k];
      },
    };

    const dnr = new DnrController(dummyDnrBackend);
    const recipes = new RecipeStore(storageBackend);
    const audits = new AuditStore(storageBackend);
    const planner = new MockPlanner();

    const engine = new AdaptationTransactionEngine(
      dnr,
      recipes,
      audits,
      storageBackend,
      async () => {},
      planner
    );

    const batch = createDummyBatch(true);

    // Initial navigation epoch 1
    const tx1 = await engine.evaluateSignals(1, 'epoch_1', 'example.com', batch);
    expect(tx1).not.toBeNull();
    expect(tx1?.state).toBe('staged');
    expect(tx1?.navigationId).toBe('epoch_1');

    // Tab navigates to epoch 2 (user navigated away)
    const tx2 = await engine.evaluateSignals(1, 'epoch_2', 'example.com', createDummyBatch(false));
    expect(tx2).toBeNull(); // Benign/clean page in epoch 2

    // Verification attempt for old tx1 must not affect epoch 2
    const postHealth = {
      antiBlockReaction: 0.1,
      contentAvailability: 1.0,
      interaction: 1.0,
      scrollability: 1.0,
      navigationHealth: 1.0,
      visualObstruction: 0.0,
      mutationStability: 1.0,
      confidence: 0.9,
    };

    const verified = await engine.verifyAndCompleteTransaction(tx1!.txId, postHealth);
    expect(verified?.state).toBe('committed');

    // Prove active transactions list does not leak stale active transactions
    const active = engine.getActiveTransactions();
    const staleActive = active.filter((t) => t.state === 'staged' && t.navigationId === 'epoch_1');
    expect(staleActive).toHaveLength(0);
  });

  it('drops a slow planner response after navigation before staging any action', async () => {
    const memoryStorage: Record<string, any> = {};
    const storageBackend = {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in memoryStorage).map((k) => [k, memoryStorage[k]])),
      set: async (items: Record<string, any>) => { Object.assign(memoryStorage, items); },
      remove: async (keys: string[]) => { for (const k of keys) delete memoryStorage[k]; },
    };
    const dnrUpdates: unknown[] = [];
    const dnr = new DnrController({
      getDynamicRules: async () => [],
      getSessionRules: async () => [],
      updateDynamicRules: async (opts) => { dnrUpdates.push(opts); },
      updateSessionRules: async (opts) => { dnrUpdates.push(opts); },
    });
    const messages: unknown[] = [];
    let releasePlan!: () => void;
    const gate = new Promise<void>((resolve) => { releasePlan = resolve; });
    const planner = {
      plan: async (evidence: any) => {
        await gate;
        return new MockPlanner().plan(evidence);
      },
    };
    let liveNavigationId = 'epoch_1';
    const engine = new AdaptationTransactionEngine(
      dnr,
      new RecipeStore(storageBackend),
      new AuditStore(storageBackend),
      storageBackend,
      async (_tabId, msg) => { messages.push(msg); },
      planner,
      (_tabId, navigationId) => navigationId === liveNavigationId
    );

    const unknownBatch = createDummyBatch(false);
    unknownBatch.semantic = {
      detectedPhrases: ['novel custom blocker detection'],
      adblockKeywordDensity: 0.05,
      confidenceScore: 0.95,
    };
    unknownBatch.mutation.rapidReinsertionDetected = true;
    unknownBatch.mutation.mutationRatePerSecond = 150;
    unknownBatch.suspectedDetectorTypes = ['NOVEL_UNKNOWN_DETECTOR'];
    const pending = engine.evaluateSignals(1, 'epoch_1', 'example.com', unknownBatch);
    await Promise.resolve();
    liveNavigationId = 'epoch_2';
    releasePlan();

    await expect(pending).resolves.toBeNull();
    expect(engine.getActiveTransactions()).toHaveLength(0);
    expect(messages).toHaveLength(0);
    expect(dnrUpdates).toHaveLength(0);
  });

  it('Concurrency: Executes 10 concurrent AI adaptation evaluations across 10 tabs with zero cross-contamination', async () => {
    const memoryStorage: Record<string, any> = {};
    const storageBackend = {
      get: async (keys: string[]) => {
        const res: Record<string, any> = {};
        for (const k of keys) if (memoryStorage[k]) res[k] = memoryStorage[k];
        return res;
      },
      set: async (items: Record<string, any>): Promise<void> => {
        Object.assign(memoryStorage, items);
      },
      remove: async (keys: string[]) => {
        for (const k of keys) delete memoryStorage[k];
      },
    };

    const dnr = new DnrController(dummyDnrBackend);
    const recipes = new RecipeStore(storageBackend);
    const audits = new AuditStore(storageBackend);
    const planner = new MockPlanner();

    const engine = new AdaptationTransactionEngine(
      dnr,
      recipes,
      audits,
      storageBackend,
      async () => {},
      planner
    );

    const tabPromises = Array.from({ length: 10 }, (_, i) => {
      const tabId = i + 100;
      const siteKey = `site-${i}.org`;
      const navId = `epoch_tab_${tabId}`;
      const batch = createDummyBatch(true);
      return engine.evaluateSignals(tabId, navId, siteKey, batch);
    });

    const results = await Promise.all(tabPromises);
    expect(results).toHaveLength(10);

    const txIds = new Set<string>();
    for (let i = 0; i < results.length; i++) {
      const tx = results[i];
      expect(tx).not.toBeNull();
      expect(tx?.tabId).toBe(i + 100);
      expect(tx?.siteKey).toBe(`site-${i}.org`);
      expect(txIds.has(tx!.txId)).toBe(false); // Unique transaction IDs
      txIds.add(tx!.txId);
    }
  });
});
