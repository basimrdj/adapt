import { describe, it, expect } from 'vitest';
import { DnrIdAllocator } from '../../src/core/dnr/ids';
import { DnrReconciler } from '../../src/core/dnr/reconcile';
import { OwnershipStore, LearnedRuleOwnership } from '../../src/core/dnr/ownership';

function makeOwnershipRecord(ruleId: number, ownerId: string, band: LearnedRuleOwnership['band']): LearnedRuleOwnership {
  return {
    schemaVersion: 1,
    ruleId,
    band,
    ownerId,
    lifecycle: band.startsWith('SESSION_') ? 'HEALTHY_SESSION' : 'PERSISTED_DYNAMIC',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestFamilyKey: 'tracker-a.test/px',
    scheme: 'https:',
    authority: 'tracker-a.test',
    host: 'tracker-a.test',
    coarsePath: '/px',
    resourceTypes: ['script'],
    hostWide: false,
    scopeClass: band.startsWith('SESSION_') ? 'session-experiment' : 'personal-blocklist',
    evidenceCount: 1,
    healthyObservationCount: 1,
    matchCount: 0,
    healthFailureCount: 0,
    rollbackCount: 0,
  };
}

function makeStore(): OwnershipStore {
  const backing = new Map<string, Record<string, unknown>>();
  const backendFor = () => ({
    get: async (key: string) => ({ [key]: backing.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) backing.set(key, value as Record<string, unknown>);
    },
  });
  return new OwnershipStore(backendFor(), backendFor());
}

const rule = (id: number): chrome.declarativeNetRequest.Rule =>
  ({ id, priority: 1, action: { type: 'block' as never }, condition: {} });

describe('DnrReconciler (ownership-driven)', () => {
  it('keeps rules with persisted ownership across a worker restart and restores allocations', async () => {
    const ownership = makeStore();
    await ownership.load();
    ownership.session.upsert(makeOwnershipRecord(3_000_010, 'survivor_ai_7_1_123', 'SESSION_SAFE'));
    ownership.durable.upsert(makeOwnershipRecord(1_000_005, 'personal_tracker-a_test', 'DYNAMIC_SAFE'));
    await ownership.flush();

    // Worker restarted: the allocator is empty even though Chrome still holds rules.
    const allocator = new DnrIdAllocator();
    const backend = {
      getSessionRules: async () => [rule(3_000_010)],
      getDynamicRules: async () => [rule(1_000_005)],
      updateSessionRules: async () => {},
      updateDynamicRules: async () => {},
    };

    const result = await new DnrReconciler().reconcile(allocator, ownership, backend);
    expect(result.reconciledSuccessfully).toBe(true);
    expect(result.orphanedSessionRulesRemoved).toEqual([]);
    expect(result.orphanedDynamicRulesRemoved).toEqual([]);
    expect(result.restoredSessionRuleIds).toEqual([3_000_010]);
    expect(result.restoredDynamicRuleIds).toEqual([1_000_005]);
    expect(allocator.isAllocated(3_000_010)).toBe(true);
    expect(allocator.isAllocated(1_000_005)).toBe(true);
  });

  it('removes in-band rules with no ownership only after repeated unknown sightings', async () => {
    const ownership = makeStore();
    await ownership.load();
    const allocator = new DnrIdAllocator();
    const removedSession: number[] = [];
    const backend = {
      getSessionRules: async () => [rule(3_000_020)],
      getDynamicRules: async () => [],
      updateSessionRules: async (opts: { removeRuleIds?: number[] }) => {
        if (opts.removeRuleIds) removedSession.push(...opts.removeRuleIds);
      },
      updateDynamicRules: async () => {},
    };

    const reconciler = new DnrReconciler();
    const first = await reconciler.reconcile(allocator, ownership, backend);
    expect(first.orphanedSessionRulesRemoved).toEqual([]);
    expect(first.unknownRuleIdsKept).toEqual([3_000_020]);
    expect(allocator.isAllocated(3_000_020)).toBe(true); // reserved while investigated

    const second = await reconciler.reconcile(allocator, ownership, backend);
    expect(second.orphanedSessionRulesRemoved).toEqual([3_000_020]);
    expect(removedSession).toEqual([3_000_020]);
    expect(allocator.isAllocated(3_000_020)).toBe(false);
  });

  it('never touches rules outside ADAPT id bands', async () => {
    const ownership = makeStore();
    await ownership.load();
    const allocator = new DnrIdAllocator();
    const removed: number[] = [];
    const backend = {
      getSessionRules: async () => [rule(42)],
      getDynamicRules: async () => [],
      updateSessionRules: async (opts: { removeRuleIds?: number[] }) => {
        if (opts.removeRuleIds) removed.push(...(opts.removeRuleIds ?? []));
      },
      updateDynamicRules: async () => {},
    };
    await new DnrReconciler().reconcile(allocator, ownership, backend);
    expect(removed).toEqual([]);
  });

  it('cleans ownership metadata whose physical rule disappeared', async () => {
    const ownership = makeStore();
    await ownership.load();
    ownership.durable.upsert(makeOwnershipRecord(1_000_077, 'personal_gone_test', 'DYNAMIC_SAFE'));
    await ownership.flush();

    const result = await new DnrReconciler().reconcile(new DnrIdAllocator(), ownership, {
      getSessionRules: async () => [],
      getDynamicRules: async () => [],
      updateSessionRules: async () => {},
      updateDynamicRules: async () => {},
    });
    expect(result.metadataRecordsCleaned).toEqual([1_000_077]);
    expect(ownership.durable.get(1_000_077)).toBeUndefined();
  });

  it('settles a stranded PROMOTING record whose physical rule landed (crash after install)', async () => {
    const ownership = makeStore();
    await ownership.load();
    const record = { ...makeOwnershipRecord(1_000_090, 'personal_crash_test', 'DYNAMIC_SAFE'), lifecycle: 'PROMOTING' as const };
    ownership.durable.upsert(record);
    await ownership.flush();

    const result = await new DnrReconciler().reconcile(new DnrIdAllocator(), ownership, {
      getSessionRules: async () => [],
      getDynamicRules: async () => [rule(1_000_090)],
      updateSessionRules: async () => {},
      updateDynamicRules: async () => {},
    });
    expect(result.promotingRecordsResolved).toEqual([1_000_090]);
    expect(ownership.durable.get(1_000_090)?.lifecycle).toBe('PERSISTED_DYNAMIC');
  });

  it('drops a stranded PROMOTING record whose physical rule never landed (crash before install)', async () => {
    const ownership = makeStore();
    await ownership.load();
    const record = { ...makeOwnershipRecord(1_000_091, 'personal_crash2_test', 'DYNAMIC_SAFE'), lifecycle: 'PROMOTING' as const };
    ownership.durable.upsert(record);
    await ownership.flush();

    const result = await new DnrReconciler().reconcile(new DnrIdAllocator(), ownership, {
      getSessionRules: async () => [],
      getDynamicRules: async () => [],
      updateSessionRules: async () => {},
      updateDynamicRules: async () => {},
    });
    expect(result.promotingRecordsResolved).toEqual([1_000_091]);
    expect(result.metadataRecordsCleaned).toEqual([1_000_091]);
    expect(ownership.durable.get(1_000_091)).toBeUndefined();
  });

  it('tolerates a corrupted ownership payload on load (starts empty, never throws)', async () => {
    const backing = new Map<string, unknown>([['adapt_dnr_dynamic_v1', { schemaVersion: 99, rules: 'not-an-object' }]]);
    const backendFor = () => ({
      get: async (key: string) => ({ [key]: backing.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) backing.set(key, value);
      },
    });
    const ownership = new OwnershipStore(backendFor(), backendFor());
    await ownership.load();
    expect(ownership.durable.all()).toEqual([]);
    ownership.durable.upsert(makeOwnershipRecord(1_000_099, 'personal_fresh_test', 'DYNAMIC_SAFE'));
    await ownership.flush();
    expect(ownership.durable.get(1_000_099)?.host).toBe('tracker-a.test');
  });
});
