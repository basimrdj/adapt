import { describe, it, expect, vi } from 'vitest';
import { AdaptationTransactionEngine } from '../../src/core/adaptation/engine';
import { DnrController } from '../../src/core/dnr/controller';
import { RecipeStore } from '../../src/core/recipes/store';
import { AuditStore } from '../../src/core/audit/store';
import { PageSignalBatch, HealthVector } from '../../src/shared/types';

describe('AdaptationTransactionEngine', () => {
  const mockStorage = {
    data: {} as Record<string, unknown>,
    get: async (keys: string[]) => {
      const res: Record<string, unknown> = {};
      keys.forEach((k) => (res[k] = mockStorage.data[k]));
      return res;
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(mockStorage.data, items);
    },
    remove: async (keys: string[]) => {
      keys.forEach((k) => delete mockStorage.data[k]);
    },
  };

  const mockDnrBackend = {
    dynamicRules: [] as chrome.declarativeNetRequest.Rule[],
    sessionRules: [] as chrome.declarativeNetRequest.Rule[],
    getDynamicRules: async () => mockDnrBackend.dynamicRules,
    getSessionRules: async () => mockDnrBackend.sessionRules,
    updateDynamicRules: async (opts: { addRules?: chrome.declarativeNetRequest.Rule[]; removeRuleIds?: number[] }) => {
      if (opts.removeRuleIds) {
        mockDnrBackend.dynamicRules = mockDnrBackend.dynamicRules.filter((r) => !opts.removeRuleIds!.includes(r.id));
      }
      if (opts.addRules) {
        mockDnrBackend.dynamicRules.push(...opts.addRules);
      }
    },
    updateSessionRules: async (opts: { addRules?: chrome.declarativeNetRequest.Rule[]; removeRuleIds?: number[] }) => {
      if (opts.removeRuleIds) {
        mockDnrBackend.sessionRules = mockDnrBackend.sessionRules.filter((r) => !opts.removeRuleIds!.includes(r.id));
      }
      if (opts.addRules) {
        mockDnrBackend.sessionRules.push(...opts.addRules);
      }
    },
  };

  it('stages an experiment when high anti-block reaction is observed and persists transaction', async () => {
    const dnrController = new DnrController(mockDnrBackend);
    const recipeStore = new RecipeStore(mockStorage);
    const auditStore = new AuditStore(mockStorage);
    const sendTabMessage = vi.fn().mockResolvedValue(undefined);

    const engine = new AdaptationTransactionEngine(
      dnrController,
      recipeStore,
      auditStore,
      mockStorage,
      sendTabMessage
    );

    const brokenBatch: PageSignalBatch = {
      navigationId: 'nav_broken_1',
      timestamp: Date.now(),
      geometry: {
        viewportWidth: 1024,
        viewportHeight: 768,
        hasFixedOverlay: true,
        overlayCoverageRatio: 0.85,
        bodyScrollLocked: true,
        htmlScrollLocked: true,
        modalCount: 1,
        mainContentHidden: false,
        mainContentHeight: 500,
      },
      semantic: {
        detectedPhrases: ['disable your ad blocker'],
        adblockKeywordDensity: 0.08,
        confidenceScore: 0.90,
      },
      interaction: {
        pointerEventsSuppressed: true,
        bodyOverflowHidden: true,
        contentCovered: true,
      },
      mutation: {
        mutationRatePerSecond: 5,
        rapidReinsertionDetected: false,
        overlayReinsertedCount: 0,
        degradationState: 'NORMAL',
      },
      suspectedDetectorTypes: ['FULLSCREEN_GATE', 'SEMANTIC_PROMPT'],
    };

    const tx = await engine.evaluateSignals(1, 'nav_broken_1', 'adversarial-news.com', brokenBatch);
    expect(tx).not.toBeNull();
    expect(tx?.state).toBe('staged');
    expect(tx?.candidate.tier).toBe('S3');
    expect(sendTabMessage).toHaveBeenCalled();

    // Verify successful outcome
    const postHealth: HealthVector = {
      antiBlockReaction: 0.05,
      contentAvailability: 1.0,
      interaction: 1.0,
      scrollability: 1.0,
      navigationHealth: 1.0,
      visualObstruction: 0.0,
      mutationStability: 1.0,
      confidence: 0.90,
    };

    const completedTx = await engine.verifyAndCompleteTransaction(tx!.txId, postHealth);
    expect(completedTx?.state).toBe('committed');

    // Verify recipe was saved locally
    const savedRecipe = await recipeStore.getRecipe('adversarial-news.com');
    expect(savedRecipe).toBeDefined();
    expect(savedRecipe?.state).toBe('provisional');
  });
});
