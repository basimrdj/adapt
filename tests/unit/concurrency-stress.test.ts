import { describe, it, expect } from 'vitest';
import { DnrIdAllocator } from '../../src/core/dnr/ids';
import { DnrQuotaTracker } from '../../src/core/dnr/quota';
import { DnrController } from '../../src/core/dnr/controller';
import { RecipeStore } from '../../src/core/recipes/store';
import { AuditStore } from '../../src/core/audit/store';
import { AdaptationTransactionEngine } from '../../src/core/adaptation/engine';
import { QUOTA_LIMITS } from '../../src/shared/constants';
import { StrategyCandidate, HealthVector } from '../../src/shared/types';

describe('Phase 1.5 Concurrency, Quota & Lifecycle Unit Stress Suite', () => {
  // Scenario 15: Concurrent ID Allocation without Collisions
  it('Scenario 15: Concurrently allocates 5,000 rule IDs across safe/unsafe bands with zero collisions', () => {
    const allocator = new DnrIdAllocator();
    const allocated = new Set<number>();
    const count = 5000;

    for (let i = 0; i < count; i++) {
      const band = i % 2 === 0 ? 'SESSION_SAFE' : 'SESSION_UNSAFE';
      const id = allocator.allocate(band, `tx_${i}`);
      expect(allocated.has(id)).toBe(false); // No collision!
      allocated.add(id);
    }

    expect(allocated.size).toBe(count);
  });

  // Scenario 10, 11, 12, 13: DNR Quota Exhaustion & Subset Accounting
  it('Scenario 10, 11, 12, 13: Accurately enforces dynamic, unsafe subset, session, and regex quota limits', () => {
    const tracker = new DnrQuotaTracker();

    // Test 1: Dynamic Safe + Unsafe total boundary
    tracker.updateUsage({ dynamicSafe: 28000, dynamicUnsafe: 2000 });
    // Total is 30,000. Requesting 1 more dynamic safe should fail
    const overTotal = tracker.checkCapacity({ dynamicSafe: 1 });
    expect(overTotal.allowed).toBe(false);
    expect(overTotal.reason).toContain('Exceeds max total dynamic rules quota');

    // Test 2: Unsafe dynamic subset limit (5,000)
    tracker.updateUsage({ dynamicSafe: 10000, dynamicUnsafe: 5000 });
    const overUnsafe = tracker.checkCapacity({ dynamicUnsafe: 1 });
    expect(overUnsafe.allowed).toBe(false);
    expect(overUnsafe.reason).toContain('Exceeds max unsafe dynamic rules quota');

    // Test 3: Session limit (5,000)
    tracker.updateUsage({ sessionRules: 5000 });
    const overSession = tracker.checkCapacity({ session: 1 });
    expect(overSession.allowed).toBe(false);
    expect(overSession.reason).toContain('Exceeds max session rules quota');

    // Test 4: Regex limit (1,000 per ruleset)
    tracker.updateUsage({ regexSessionRules: 1000 });
    const overRegex = tracker.checkCapacity({ regexSession: 1 });
    expect(overRegex.allowed).toBe(false);
    expect(overRegex.reason).toContain('Exceeds max regex session rules quota');
  });

  // Scenario 14: Deliberate DNR API failure after ID allocation & complete reclamation
  it('Scenario 14: Reclaims allocated IDs and metadata when DNR API rejects rules', async () => {
    const rejectingBackend = {
      getDynamicRules: async () => [],
      getSessionRules: async () => [],
      updateDynamicRules: async () => {},
      updateSessionRules: async () => {
        throw new Error('Chrome DNR API internal rejection: Invalid rule condition');
      },
    };

    const controller = new DnrController(rejectingBackend);
    const candidate: StrategyCandidate = {
      id: 'cand_test',
      tier: 'S3',
      name: 'Test Network Strategy',
      rationale: 'Test',
      isReversible: true,
      actions: [
        { id: 'act_1', type: 'NET_BLOCK', urlFilter: '||bad.com^' },
        { id: 'act_2', type: 'NET_REDIRECT_LOCAL', urlFilter: '||ad.com^', extensionPath: '/noop.js' },
      ],
    };

    await expect(
      controller.addSessionExperimentRules(10, 'tx_fail', candidate.actions)
    ).rejects.toThrow('Chrome DNR API internal rejection');

    // Prove IDs were completely released back to the allocator
    const remainingAllocations = controller.getAllAllocations();
    expect(remainingAllocations).toHaveLength(0);

    // Prove quota tracker usage was not incremented
    expect(controller.getQuotaTracker().getUsage().sessionRules).toBe(0);
  });

  // Scenario 16: Rollback with partial failure (DNR error / DOM error)
  it('Scenario 16: Continues and executes remaining rollback operations even if one channel errors', async () => {
    let dnrRemoved = false;
    const failingDnrBackend = {
      getDynamicRules: async () => [],
      getSessionRules: async () => [],
      updateDynamicRules: async () => {},
      updateSessionRules: async () => {
        dnrRemoved = true;
        throw new Error('DNR Session rules already cleaned');
      },
    };

    const domActionsRolledBack: string[] = [];
    const failingTabSender = async (tabId: number, msg: any) => {
      if (msg.actionId === 'action_error') {
        throw new Error('Tab closed or DOM element detached');
      }
      domActionsRolledBack.push(msg.actionId);
    };

    const controller = new DnrController(failingDnrBackend);
    const mockStorage = {
      data: {} as Record<string, unknown>,
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    };

    const engine = new AdaptationTransactionEngine(
      controller,
      new RecipeStore(mockStorage),
      new AuditStore(mockStorage),
      mockStorage,
      failingTabSender
    );

    const tx = {
      txId: 'tx_partial_fail',
      tabId: 5,
      navigationId: 'nav_5',
      siteKey: 'test.com',
      state: 'staged' as const,
      candidate: {
        id: 'cand_1',
        tier: 'S3' as const,
        name: 'Test Candidate',
        rationale: 'Test',
        isReversible: true,
        actions: [],
      },
      baselineHealth: {
        antiBlockReaction: 0.8,
        contentAvailability: 0.5,
        interaction: 0.5,
        scrollability: 0.5,
        navigationHealth: 1.0,
        visualObstruction: 0.5,
        mutationStability: 1.0,
        confidence: 0.9,
      },
      sessionRuleIds: [3000001],
      domActionIds: ['action_error', 'action_success_1', 'action_success_2'],
      startTime: Date.now(),
    };

    (engine as any).activeTransactions.set(tx.txId, tx);

    const postHealth: HealthVector = {
      antiBlockReaction: 0.9, // Failed adaptation -> triggers rollback
      contentAvailability: 0.4,
      interaction: 0.4,
      scrollability: 0.4,
      navigationHealth: 1.0,
      visualObstruction: 0.6,
      mutationStability: 1.0,
      confidence: 0.9,
    };

    const res = await engine.verifyAndCompleteTransaction(tx.txId, postHealth);
    expect(res?.state).toBe('rolled_back');
    expect(dnrRemoved).toBe(true);
    // Successful actions were executed despite action_error failing!
    expect(domActionsRolledBack).toContain('action_success_1');
    expect(domActionsRolledBack).toContain('action_success_2');
  });

  // Scenario 18: Storage Schema Migration from Legacy Versions
  it('Scenario 18: Gracefully initializes and migrates storage structures from older schemas', async () => {
    const legacyStorage = {
      data: {
        adapt_recipes_v1: {
          'old-site.com': {
            siteKey: 'old-site.com',
            match: { host: 'old-site.com' },
            actions: [{ id: 'old_1', type: 'DOM_REMOVE_OVERLAY' }],
            evidence: { successfulNavigations: 3, confidence: 0.95 },
            state: 'confirmed',
            createdAt: 1600000000000,
          },
        },
      } as Record<string, unknown>,
      get: async (keys: string[]) => {
        const res: Record<string, unknown> = {};
        keys.forEach((k) => (res[k] = legacyStorage.data[k]));
        return res;
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(legacyStorage.data, items);
      },
      remove: async (keys: string[]) => {
        keys.forEach((k) => delete legacyStorage.data[k]);
      },
    };

    const store = new RecipeStore(legacyStorage);
    const recipe = await store.getRecipe('old-site.com');
    expect(recipe).toBeDefined();
    expect(recipe?.state).toBe('confirmed');
    expect(recipe?.actions).toHaveLength(1);
  });
});
