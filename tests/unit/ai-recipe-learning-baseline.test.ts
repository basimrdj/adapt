import { describe, it, expect } from 'vitest';
import { AdaptationTransactionEngine } from '../../src/core/adaptation/engine';
import { DnrController } from '../../src/core/dnr/controller';
import { RecipeStore } from '../../src/core/recipes/store';
import { AuditStore } from '../../src/core/audit/store';
import { PageSignalBatch } from '../../src/shared/types';
import { MockPlanner } from '../../src/shared/ai/mock-planner';

describe('Phase 2.5 Recipe Learning & AI vs Deterministic Baseline Suite', () => {
  const dummyDnrBackend = {
    getDynamicRules: async () => [],
    getSessionRules: async () => [],
    updateDynamicRules: async () => {},
    updateSessionRules: async () => {},
  };

  const createUnknownReactionBatch = (): PageSignalBatch => ({
    navigationId: 'epoch_novel',
    timestamp: Date.now(),
    geometry: {
      viewportWidth: 1920,
      viewportHeight: 1080,
      hasFixedOverlay: false, // Novel detector without standard fixed overlay
      overlayCoverageRatio: 0.0,
      bodyScrollLocked: false,
      htmlScrollLocked: false,
      modalCount: 0,
      mainContentHidden: false,
      mainContentHeight: 1000,
    },
    semantic: {
      detectedPhrases: ['novel custom blocker detection'],
      adblockKeywordDensity: 0.05,
      confidenceScore: 0.95,
    },
    interaction: {
      pointerEventsSuppressed: false,
      bodyOverflowHidden: false,
      contentCovered: false,
    },
    mutation: {
      mutationRatePerSecond: 150,
      rapidReinsertionDetected: true,
      overlayReinsertedCount: 0,
      degradationState: 'NORMAL',
    },
    suspectedDetectorTypes: ['NOVEL_UNKNOWN_DETECTOR'], // Unknown to Phase 1 heuristics
  });

  it('Proves 100% AI call reduction on second visit after recipe is learned', async () => {
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

    let aiCallCount = 0;
    const trackingPlanner = {
      plan: async (evidence: any) => {
        aiCallCount++;
        const defaultMock = new MockPlanner();
        return defaultMock.plan(evidence);
      },
    };

    const engine = new AdaptationTransactionEngine(
      dnr,
      recipes,
      audits,
      storageBackend,
      async () => {},
      trackingPlanner
    );

    const siteKey = 'novel-anti-adblock-site.com';
    const batch = createUnknownReactionBatch();

    // 1. FIRST VISIT: Novel reaction requires AI Planner
    expect(aiCallCount).toBe(0);
    const tx1 = await engine.evaluateSignals(1, 'epoch_visit_1', siteKey, batch);
    expect(tx1).not.toBeNull();
    expect(aiCallCount).toBe(1); // AI called on first visit

    // Verify transaction and promote recipe
    const postHealthGood = {
      antiBlockReaction: 0.1,
      contentAvailability: 1.0,
      interaction: 1.0,
      scrollability: 1.0,
      navigationHealth: 1.0,
      visualObstruction: 0.0,
      mutationStability: 1.0,
      confidence: 0.9,
    };
    await engine.verifyAndCompleteTransaction(tx1!.txId, postHealthGood);

    // Promote provisional recipe to confirmed
    const savedRecipe = await recipes.getRecipe(siteKey);
    expect(savedRecipe).not.toBeNull();
    savedRecipe!.state = 'confirmed';
    await recipes.saveRecipe(savedRecipe!);

    // 2. SECOND VISIT: Confirmed recipe used -> 0 AI calls needed
    const tx2 = await engine.evaluateSignals(1, 'epoch_visit_2', siteKey, batch);
    expect(tx2).toBeNull(); // Already handled by confirmed recipe
    expect(aiCallCount).toBe(1); // Still 1! Zero new AI calls on second visit (100% reduction)
  });

  it('Direct Comparison: AI-assisted engine recovers novel reactions where deterministic-only engine cannot', async () => {
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

    // Engine WITHOUT AI Planner (Deterministic baseline only)
    const deterministicOnlyEngine = new AdaptationTransactionEngine(
      dnr,
      recipes,
      audits,
      storageBackend,
      async () => {}
    );

    // Engine WITH AI Planner
    const aiEngine = new AdaptationTransactionEngine(
      dnr,
      recipes,
      audits,
      storageBackend,
      async () => {},
      new MockPlanner()
    );

    const novelBatch = createUnknownReactionBatch();

    // Deterministic baseline produces no candidate for unknown reaction
    const detResult = await deterministicOnlyEngine.evaluateSignals(
      1,
      'epoch_det',
      'obscure-site.org',
      novelBatch
    );
    expect(detResult).toBeNull(); // Deterministic baseline cannot resolve

    // AI-assisted engine evaluates and stages candidate successfully
    const aiResult = await aiEngine.evaluateSignals(2, 'epoch_ai', 'obscure-site.org', novelBatch);
    expect(aiResult).not.toBeNull();
    expect(aiResult?.state).toBe('staged');
  });
});
