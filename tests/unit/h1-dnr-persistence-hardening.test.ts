/**
 * H1 hardening pins — DNR + persistence correctness defects found by deep recon:
 *
 *  1. allocator band-ceiling wrap (silent cross-band allocation)
 *  2. allocator in-band exhaustion throws (never leaks a foreign-band id)
 *  3. adopt() reserves out-of-band recovered ids
 *  4. quota tracker + rule metadata reseeded from physical ground truth at startup
 *  5. removal backend failure keeps allocator/meta/quota/ownership consistent
 *  6. promotion verify-READ ambiguity leaves the PROMOTING journal record intact
 *  7. reconcile read failure → reconciledSuccessfully=false, no reseed
 *  8. foreign ownership schema → orphan removal suppressed (no mass-removal cascade)
 *  9. writeChain rejection recovery (one transient storage error ≠ permanent stall)
 * 10. enforceCapacity eviction order + failure consistency
 * 11. promotion retry backoff bounds the quota-rejection storm
 * 12. INVALIDATED recipe lifecycle survives restart (no RECIPE_SAFE re-inference)
 * 13. event-graph store LRU cap keeps the session snapshot inside quota
 */
import { describe, it, expect } from 'vitest';
import { DnrIdAllocator } from '../../src/core/dnr/ids';
import { DnrController, DnrBackend } from '../../src/core/dnr/controller';
import { DnrReconciler } from '../../src/core/dnr/reconcile';
import { OwnershipStore, LearnedRuleOwnership } from '../../src/core/dnr/ownership';
import { PersonalLearningManager } from '../../src/background/learning/personal-learning';
import { CausalSessionStateRepository } from '../../src/background/causal/session-state';
import { EventGraphStore, MAX_GRAPH_SLOTS } from '../../src/background/causal/graph-store';
import { NavigationRegistry } from '../../src/core/navigation/registry';
import { BeliefUpdater } from '../../src/background/causal/belief-updater';
import { CausalRecipeStore, PromotionGate } from '../../src/background/causal/promotion-gate';
import { StorageBackend } from '../../src/core/recipes/store';
import { ID_BANDS } from '../../src/shared/constants';
import { CausalRecipe } from '../../src/shared/causal/recipes';
import { CausalDocumentKey } from '../../src/shared/causal/events';

type Rule = chrome.declarativeNetRequest.Rule;

function installChromeStub(): void {
  const areaFor = () => {
    const backing = new Map<string, unknown>();
    return {
      get: async (key: string) => ({ [key]: backing.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) backing.set(key, value);
      },
    };
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: areaFor(), local: areaFor() },
  };
}

function makeOwnershipBackend(initial?: Record<string, unknown>) {
  const backing = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    backing,
    get: async (key: string) => ({ [key]: backing.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
  };
}

function makeStore(initial?: Record<string, unknown>): OwnershipStore {
  return new OwnershipStore(makeOwnershipBackend(initial), makeOwnershipBackend(initial));
}

function makeBackend(opts?: { failSessionRemove?: boolean; failDynamic?: boolean; failDynamicRead?: boolean }) {
  const session = new Map<number, Rule>();
  const dynamic = new Map<number, Rule>();
  let dynamicWriteAttempts = 0;
  const backend: DnrBackend = {
    getSessionRules: async () => [...session.values()],
    getDynamicRules: async () => {
      if (opts?.failDynamicRead) throw new Error('dynamic-read-failed');
      return [...dynamic.values()];
    },
    updateSessionRules: async (u) => {
      if (opts?.failSessionRemove && (u.removeRuleIds?.length ?? 0) > 0) throw new Error('session-remove-failed');
      for (const id of u.removeRuleIds ?? []) session.delete(id);
      for (const rule of u.addRules ?? []) session.set(rule.id, rule);
    },
    updateDynamicRules: async (u) => {
      dynamicWriteAttempts++;
      if (opts?.failDynamic) throw new Error('dynamic-write-failed');
      for (const id of u.removeRuleIds ?? []) dynamic.delete(id);
      for (const rule of u.addRules ?? []) dynamic.set(rule.id, rule);
    },
  };
  return { backend, session, dynamic, writeAttempts: () => dynamicWriteAttempts };
}

function makeRecord(ruleId: number, band: LearnedRuleOwnership['band'], overrides?: Partial<LearnedRuleOwnership>): LearnedRuleOwnership {
  return {
    schemaVersion: 1,
    ruleId,
    band,
    ownerId: `owner_${ruleId}`,
    lifecycle: band.startsWith('SESSION_') ? 'HEALTHY_SESSION' : 'PERSISTED_DYNAMIC',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestFamilyKey: `fam-${ruleId}.test/px`,
    scheme: 'https:',
    authority: `fam-${ruleId}.test`,
    host: `fam-${ruleId}.test`,
    coarsePath: '/px',
    resourceTypes: ['script'],
    hostWide: false,
    scopeClass: band.startsWith('SESSION_') ? 'session-experiment' : 'personal-blocklist',
    evidenceCount: 1,
    healthyObservationCount: 1,
    matchCount: 0,
    healthFailureCount: 0,
    rollbackCount: 0,
    ...overrides,
  };
}

const blockAction = (host: string, isRegex = false) => ({
  id: `a_${host}`,
  type: 'NET_BLOCK' as const,
  urlFilter: isRegex ? `^https://${host.replace(/\./g, '\\.')}/px/.*` : `|https://${host}/px/a*`,
  isRegex,
  resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType],
});

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe('H1.1-3 allocator band integrity', () => {
  it('wraps at the band ceiling instead of leaking into the next band', () => {
    const allocator = new DnrIdAllocator([
      { id: ID_BANDS.SESSION_SAFE_MAX, band: 'SESSION_SAFE', ownerId: 'tx_edge', allocatedAt: Date.now() },
    ]);
    const id = allocator.allocate('SESSION_SAFE', 'tx_wrap');
    expect(id).toBeGreaterThanOrEqual(ID_BANDS.SESSION_SAFE_MIN);
    expect(id).toBeLessThanOrEqual(ID_BANDS.SESSION_SAFE_MAX);
    expect(id).toBe(ID_BANDS.SESSION_SAFE_MIN);
    // The wrapped id must remain usable and tracked.
    expect(allocator.isAllocated(id)).toBe(true);
    const next = allocator.allocate('SESSION_SAFE', 'tx_wrap2');
    expect(next).toBe(ID_BANDS.SESSION_SAFE_MIN + 1);
  });

  it('throws on true in-band exhaustion and never hands out a foreign-band id', () => {
    const allocator = new DnrIdAllocator();
    // Seed the ceiling so the next allocate wraps, then occupy the entire floor
    // window the wrap walk would visit — the full band minus the seeded ceiling.
    const allocations = [];
    for (let id = ID_BANDS.SESSION_UNSAFE_MIN; id <= ID_BANDS.SESSION_UNSAFE_MAX; id++) {
      allocations.push({ id, band: 'SESSION_UNSAFE' as const, ownerId: 'fill', allocatedAt: 0 });
    }
    const full = new DnrIdAllocator(allocations);
    expect(() => full.allocate('SESSION_UNSAFE', 'overflow')).toThrow(/Exhausted DNR Rule ID pool/);
    // The failed allocation must not have touched state.
    expect(full.getAllAllocations()).toHaveLength(allocations.length);
    void allocator;
  }, 30_000);

  it('adopt reserves out-of-band recovered ids so allocate never reuses them', () => {
    const allocator = new DnrIdAllocator();
    const foreignId = ID_BANDS.SESSION_SAFE_MAX + 7; // cross-band leak from a legacy build
    allocator.adopt([{ id: foreignId, band: 'SESSION_SAFE', ownerId: 'legacy', allocatedAt: Date.now() }]);
    expect(allocator.isAllocated(foreignId)).toBe(true);
    for (let i = 0; i < 5; i++) {
      const id = allocator.allocate('SESSION_SAFE', `tx_${i}`);
      expect(id).not.toBe(foreignId);
      expect(id).toBeLessThanOrEqual(ID_BANDS.SESSION_SAFE_MAX);
    }
  });
});

describe('H1.4 quota + metadata reseed from ground truth', () => {
  it('reseeds the quota tracker and rule metadata from physical rules at startup', async () => {
    installChromeStub();
    const ownership = makeStore();
    await ownership.load();
    const { backend, session, dynamic } = makeBackend();
    // Physical truth this "browser" already holds: 2 session (1 regex), 2 dynamic
    // (1 unsafe-band redirect, 1 regex).
    session.set(ID_BANDS.SESSION_SAFE_MIN + 10, { id: ID_BANDS.SESSION_SAFE_MIN + 10, priority: 500, action: { type: 'block' as never }, condition: { urlFilter: '|https://a.test/px*' } });
    session.set(ID_BANDS.SESSION_SAFE_MIN + 11, { id: ID_BANDS.SESSION_SAFE_MIN + 11, priority: 500, action: { type: 'block' as never }, condition: { regexFilter: '^https://b\\.test/px/' } });
    dynamic.set(ID_BANDS.DYNAMIC_SAFE_MIN + 5, { id: ID_BANDS.DYNAMIC_SAFE_MIN + 5, priority: 100, action: { type: 'block' as never }, condition: { urlFilter: '|https://c.test/px*' } });
    dynamic.set(ID_BANDS.DYNAMIC_UNSAFE_MIN + 5, { id: ID_BANDS.DYNAMIC_UNSAFE_MIN + 5, priority: 200, action: { type: 'redirect' as never }, condition: { regexFilter: '^https://d\\.test/' } });

    const controller = new DnrController(backend, ownership);
    const result = await controller.restoreOwnershipAndReconcile();
    expect(result?.reconciledSuccessfully).toBe(true);

    const usage = controller.getQuotaTracker().getUsage();
    expect(usage.sessionRules).toBe(2);
    expect(usage.regexSessionRules).toBe(1);
    expect(usage.dynamicSafe).toBe(1);
    expect(usage.dynamicUnsafe).toBe(1);
    expect(usage.regexDynamicRules).toBe(1);

    // Removal of a restored rule must refund the reseeded quota accurately.
    await controller.removeSessionExperimentRules([ID_BANDS.SESSION_SAFE_MIN + 11], 'tab-close-cleanup');
    expect(controller.getQuotaTracker().getUsage().regexSessionRules).toBe(0);
    expect(controller.getQuotaTracker().getUsage().sessionRules).toBe(1);
  });
});

describe('H1.5 removal failure keeps all state consistent', () => {
  it('failed session removal keeps ids allocated, metadata intact, quota charged, ownership present', async () => {
    installChromeStub();
    const ownership = makeStore();
    await ownership.load();
    const { backend, session } = makeBackend({ failSessionRemove: true });
    const controller = new DnrController(backend, ownership);

    const { ruleIds } = await controller.addSessionExperimentRules(undefined, 'tx_fail', [
      blockAction('plain-fail.test'),
      blockAction('regex-fail.test', true),
    ]);
    expect(ruleIds).toHaveLength(2);
    const before = controller.getQuotaTracker().getUsage();
    expect(before.sessionRules).toBe(2);
    expect(before.regexSessionRules).toBe(1);

    await expect(controller.removeSessionExperimentRules(ruleIds, 'executor-rollback')).rejects.toThrow('session-remove-failed');

    // Nothing moved: the rules are still live in Chrome.
    for (const id of ruleIds) expect(controller.getAllAllocations().some((a) => a.id === id)).toBe(true);
    const after = controller.getQuotaTracker().getUsage();
    expect(after.sessionRules).toBe(2);
    expect(after.regexSessionRules).toBe(1);
    expect(ownership.session.get(ruleIds[0]!)?.lifecycle).toBe('STAGED_SESSION');
    expect(session.size).toBe(2);

    // Recovery: once the backend heals, removal tears everything down.
    (backend as { updateSessionRules: unknown }).updateSessionRules = async (u: { removeRuleIds?: number[] }) => {
      for (const id of u.removeRuleIds ?? []) session.delete(id);
    };
    await controller.removeSessionExperimentRules(ruleIds, 'executor-rollback');
    expect(controller.getQuotaTracker().getUsage().sessionRules).toBe(0);
    expect(controller.getQuotaTracker().getUsage().regexSessionRules).toBe(0);
    for (const id of ruleIds) expect(controller.getAllAllocations().some((a) => a.id === id)).toBe(false);
    expect(ownership.session.get(ruleIds[0]!)?.lifecycle).toBe('REVOKED');
  });
});

describe('H1.6 promotion verify-read ambiguity', () => {
  it('a failed verify READ keeps the PROMOTING record and allocation for reconcile to settle', async () => {
    installChromeStub();
    const ownership = makeStore();
    await ownership.load();
    // Writes succeed, reads fail: the physical rule lands but verification is blind.
    const { backend, session, dynamic } = makeBackend({ failDynamicRead: true });
    const controller = new DnrController(backend, ownership);
    const manager = new PersonalLearningManager(controller);

    const { ruleIds } = await controller.addSessionExperimentRules(undefined, 'tx_amb', [blockAction('amb.test')]);
    manager.registerStagedContext('tx_amb', { siteKey: 'site-a.test', confidence: 0.9 });
    manager.markHealthy('tx_amb');
    await settle();
    const sessionId = ruleIds[0]!;

    await expect(
      controller.promoteSessionRuleToDynamic(sessionId, { ownerId: 'personal_amb_test', reason: 'test', hostWide: false })
    ).rejects.toThrow('dynamic-read-failed');

    // The journal record survives as PROMOTING and the id stays allocated — the
    // startup reconciler owns settling this from ground truth, not the error path.
    const stranded = ownership.durable.all().filter((r) => r.host === 'amb.test');
    expect(stranded).toHaveLength(1);
    expect(stranded[0]!.lifecycle).toBe('PROMOTING');
    expect(controller.getAllAllocations().some((a) => a.id === stranded[0]!.ruleId)).toBe(true);
    // The physical rule really did land — exactly the divergence the journal exists for.
    expect(dynamic.size).toBe(1);
    expect(session.size).toBeGreaterThan(0); // session protection untouched
  });

  it('definitively-absent verify (read ok, rule missing) tears the journal record down', async () => {
    installChromeStub();
    const ownership = makeStore();
    await ownership.load();
    const { backend } = makeBackend();
    const controller = new DnrController(backend, ownership);
    const manager = new PersonalLearningManager(controller);

    const { ruleIds } = await controller.addSessionExperimentRules(undefined, 'tx_absent', [blockAction('absent.test')]);
    manager.registerStagedContext('tx_absent', { siteKey: 'site-a.test', confidence: 0.9 });
    manager.markHealthy('tx_absent');
    await settle();

    // The write silently drops adds (simulating a ruleset that never materializes).
    const original = backend.updateDynamicRules;
    (backend as { updateDynamicRules: unknown }).updateDynamicRules = async () => {};
    await expect(
      controller.promoteSessionRuleToDynamic(ruleIds[0]!, { ownerId: 'personal_absent_test', reason: 'test', hostWide: false })
    ).rejects.toThrow('dynamic-rule-verify-failed');
    (backend as { updateDynamicRules: unknown }).updateDynamicRules = original;

    expect(ownership.durable.all().filter((r) => r.host === 'absent.test')).toEqual([]);
    expect(controller.getAllAllocations().some((a) => a.ownerId === 'personal_absent_test')).toBe(false);
  });
});

describe('H1.7-8 reconcile failure + foreign schema', () => {
  it('a failing rules read marks the reconcile unsuccessful and adopts nothing', async () => {
    const ownership = makeStore();
    await ownership.load();
    const allocator = new DnrIdAllocator();
    const result = await new DnrReconciler().reconcile(allocator, ownership, {
      getSessionRules: async () => { throw new Error('session-read-failed'); },
      getDynamicRules: async () => [],
      updateSessionRules: async () => {},
      updateDynamicRules: async () => {},
    });
    expect(result.reconciledSuccessfully).toBe(false);
    expect(result.errors.join(' ')).toContain('session-read-failed');
    // Nothing adopted, nothing removed — the next wake retries from scratch.
    expect(allocator.getAllAllocations()).toEqual([]);
  });

  it('foreign ownership schema suppresses orphan removal entirely (no mass-removal cascade)', async () => {
    installChromeStub();
    // A well-formed payload from a newer schema version this build cannot read.
    const foreign = {
      schemaVersion: 2,
      rules: { '3000050': { ...makeRecord(3_000_050, 'SESSION_SAFE'), schemaVersion: 2 } },
      unknownSightings: {},
    };
    const ownership = makeStore({ adapt_dnr_ownership_session_v1: foreign });
    await ownership.load();
    expect(ownership.hasForeignSchema()).toBe(true);

    const allocator = new DnrIdAllocator();
    const removed: number[] = [];
    const reconciler = new DnrReconciler();
    const backend = {
      getSessionRules: async () => [{ id: 3_000_050, priority: 500, action: { type: 'block' as never }, condition: {} } as Rule],
      getDynamicRules: async () => [] as Rule[],
      updateSessionRules: async (u: { removeRuleIds?: number[] }) => { removed.push(...(u.removeRuleIds ?? [])); },
      updateDynamicRules: async () => {},
    };
    // Two full grace reconciles — the rule must survive BOTH.
    const first = await reconciler.reconcile(allocator, ownership, backend);
    const second = await reconciler.reconcile(allocator, ownership, backend);
    expect(first.foreignSchemaProtected).toBe(true);
    expect(second.orphanedSessionRulesRemoved).toEqual([]);
    expect(removed).toEqual([]);
    // The id is reserved while unreadable ownership is investigated.
    expect(allocator.isAllocated(3_000_050)).toBe(true);
  });
});

describe('H1.9 writeChain rejection recovery', () => {
  class FlakyStorage implements StorageBackend {
    data: Record<string, unknown> = {};
    failNext = false;
    async get(keys: string[]) {
      return Object.fromEntries(keys.filter((key) => key in this.data).map((key) => [key, this.data[key]]));
    }
    async set(items: Record<string, unknown>) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('transient-storage-error');
      }
      Object.assign(this.data, structuredClone(items));
    }
    async remove(keys: string[]) { for (const key of keys) delete this.data[key]; }
  }

  it('one rejected write does not stall the chain; later writes land', async () => {
    const backend = new FlakyStorage();
    const repo = new CausalSessionStateRepository(backend, new NavigationRegistry(), new EventGraphStore(), new BeliefUpdater());

    backend.failNext = true;
    await expect(repo.persist()).rejects.toThrow('transient-storage-error');
    expect(repo.getWriteFailures()).toBe(1);

    // The very next persist must run its write (pre-fix: chained off the rejected
    // promise, so the snapshot was silently dropped forever).
    await repo.persist();
    expect(backend.data['adapt_causal_session_state_v1']).toBeDefined();
    expect(repo.getWriteFailures()).toBe(1);
  });
});

describe('H1.10-11 capacity eviction + promotion backoff', () => {
  it('enforceCapacity evicts demoted then stalest zero-match rules, keeps recently matched', async () => {
    installChromeStub();
    const ownership = makeStore();
    await ownership.load();
    const { backend, dynamic } = makeBackend();
    const controller = new DnrController(backend, ownership);
    const manager = new PersonalLearningManager(controller);

    const stale = 1_000_100;
    const demoted = 1_000_101;
    const valuable = 1_000_102;
    ownership.durable.upsert(makeRecord(stale, 'DYNAMIC_SAFE', { createdAt: Date.now() - 90 * 24 * 3600e3, matchCount: 0 }));
    ownership.durable.upsert(makeRecord(demoted, 'DYNAMIC_SAFE', { lifecycle: 'DEMOTED', matchCount: 3, lastMatchedAt: Date.now() - 40 * 24 * 3600e3 }));
    ownership.durable.upsert(makeRecord(valuable, 'DYNAMIC_SAFE', { matchCount: 9, lastMatchedAt: Date.now() }));
    for (const id of [stale, demoted, valuable]) {
      dynamic.set(id, { id, priority: 100, action: { type: 'block' as never }, condition: { urlFilter: `|https://fam-${id}.test/px*` } });
    }
    manager.rebuildIndex();

    const evicted = await manager.enforceCapacity(0);
    expect(evicted).toBe(2);
    expect(dynamic.has(stale)).toBe(false);
    expect(dynamic.has(demoted)).toBe(false);
    expect(dynamic.has(valuable)).toBe(true);
    expect(ownership.durable.get(stale)).toBeUndefined();
    expect(ownership.durable.get(demoted)).toBeUndefined();
    expect(ownership.durable.get(valuable)?.lifecycle).toBe('PERSISTED_DYNAMIC');
  });

  it('a failed eviction removal keeps ownership records and the match index intact', async () => {
    installChromeStub();
    const ownership = makeStore();
    await ownership.load();
    const { backend, dynamic } = makeBackend({ failDynamic: true });
    const controller = new DnrController(backend, ownership);
    const manager = new PersonalLearningManager(controller);

    const demoted = 1_000_200;
    ownership.durable.upsert(makeRecord(demoted, 'DYNAMIC_SAFE', { lifecycle: 'DEMOTED', host: 'evict-fail.test', authority: 'evict-fail.test', requestFamilyKey: 'evict-fail.test/px' }));
    dynamic.set(demoted, { id: demoted, priority: 100, action: { type: 'block' as never }, condition: { urlFilter: '|https://evict-fail.test/px*' } });
    manager.rebuildIndex();

    await expect(manager.enforceCapacity(0)).rejects.toThrow('dynamic-write-failed');
    expect(dynamic.has(demoted)).toBe(true);
    expect(ownership.durable.get(demoted)).toBeDefined();
    expect(manager.isFamilyCovered('evict-fail.test', 'script')).toBe(false); // DEMOTED ≠ PERSISTED_DYNAMIC
    expect(manager.personalRuleCount()).toBe(1);
  });

  it('promotion retries are bounded after consecutive quota-style failures', async () => {
    installChromeStub();
    const ownership = makeStore();
    await ownership.load();
    const { backend, writeAttempts } = makeBackend({ failDynamic: true });
    const controller = new DnrController(backend, ownership);
    const manager = new PersonalLearningManager(controller);

    const { ruleIds } = await controller.addSessionExperimentRules(undefined, 'tx_backoff', [blockAction('backoff.test')]);
    manager.registerStagedContext('tx_backoff', { siteKey: 'site-a.test', confidence: 0.9 });
    manager.markHealthy('tx_backoff');
    await settle();
    expect(ruleIds[0]).toBeDefined();
    const attemptsAtStart = writeAttempts();

    for (let i = 0; i < 6; i++) {
      manager.observeRequestInitiation('https://backoff.test/px/a/x.js', 'script', 'https://site-a.test/page', `r${i}`);
      await settle(60);
    }
    // 3 real attempts, then the backoff gate swallows the rest — no retry storm.
    expect(writeAttempts() - attemptsAtStart).toBe(3);
    // The session protection stays live the whole time.
    expect(ownership.session.get(ruleIds[0]!)?.lifecycle).toBe('HEALTHY_SESSION');
  }, 20_000);
});

describe('H1.12 INVALIDATED lifecycle survives restart', () => {
  const recipe: CausalRecipe = {
    id: 'recipe:rcp9001',
    version: 1,
    originHash: 'deadbeef',
    fingerprintConstraints: { originHash: 'deadbeef' },
    preconditions: [],
    actionRefs: ['element:e1'],
    causalSupport: { hypothesisClass: 'OVERLAY_REINSERTION', posterior: 0.9, experiments: 5, stableReplays: 6 },
    expectedHealthDelta: 0.2,
    minPrivacyScore: 0.95,
    rollbackPlanRef: 'rollback:r1',
  };
  const fingerprint = { originHash: 'deadbeef', topLevelPathClass: 'article' } as never;

  it('replay honours the persisted INVALIDATED record even when the map is cold', async () => {
    class MemoryStorage implements StorageBackend {
      data: Record<string, unknown> = {};
      async get(keys: string[]) {
        return Object.fromEntries(keys.filter((key) => key in this.data).map((key) => [key, this.data[key]]));
      }
      async set(items: Record<string, unknown>) { Object.assign(this.data, structuredClone(items)); }
      async remove(keys: string[]) { for (const key of keys) delete this.data[key]; }
    }
    const store = new CausalRecipeStore(new MemoryStorage());
    await store.save({ recipe, lifecycle: 'INVALIDATED', updatedWallMs: Date.now() });

    // Fresh gate = restarted worker: the in-memory map is empty.
    const gate = new PromotionGate({ store });
    await gate.hydrateLifecycles();
    const replayed = gate.replay(recipe, fingerprint, 0.25, true);
    expect(replayed.lifecycle).toBe('INVALIDATED');
    expect(replayed.applied).toBe(false);

    // Without hydration, an explicit persisted lifecycle must still win over inference.
    const gate2 = new PromotionGate();
    const replayed2 = gate2.replay(recipe, fingerprint, 0.25, true, 'INVALIDATED');
    expect(replayed2.lifecycle).toBe('INVALIDATED');
    expect(replayed2.applied).toBe(false);

    // Control: with no stored signal, inference from stableReplays still works.
    const gate3 = new PromotionGate();
    const replayed3 = gate3.replay(recipe, fingerprint, 0.25, true);
    expect(replayed3.lifecycle).toBe('RECIPE_SAFE');
  });
});

describe('H1.13 session snapshot bounds', () => {
  const scope = (n: number): CausalDocumentKey => ({
    tabId: 1,
    navigationEpoch: n,
    documentId: `doc-${n}`,
    frameId: 0,
  });

  it('graph slots are LRU-capped so the persisted snapshot stays bounded', () => {
    const store = new EventGraphStore();
    const total = MAX_GRAPH_SLOTS + 5;
    for (let i = 0; i < total; i++) store.getOrCreate(scope(i), 'originhash');
    expect(store.getAll()).toHaveLength(MAX_GRAPH_SLOTS);
    // The oldest five were evicted; the newest survive.
    for (let i = 0; i < 5; i++) expect(store.get(scope(i))).toBeUndefined();
    expect(store.get(scope(total - 1))).toBeDefined();
  });

  it('hydrate keeps only the newest graphs when the snapshot exceeded the cap', () => {
    const store = new EventGraphStore();
    const total = MAX_GRAPH_SLOTS + 7;
    const graphs = [] as ReturnType<EventGraphStore['getAll']>;
    for (let i = 0; i < total; i++) graphs.push(store.getOrCreate(scope(i), 'originhash'));
    const rehydrated = new EventGraphStore();
    rehydrated.hydrate(graphs);
    expect(rehydrated.getAll()).toHaveLength(MAX_GRAPH_SLOTS);
    expect(rehydrated.get(scope(total - 1))).toBeDefined();
  });
});
