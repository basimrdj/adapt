/**
 * AiNegativeMemoryStore — per-site AI failure budget with escalating cooldown.
 *
 * Pins the deterministic policy: 3 consecutive site-signaling failures → 1h
 * cooldown, 4 → 6h, ≥5 → 24h; verified-healthy success wipes the streak;
 * 7-day silence decays the count; LRU bounds the map; corrupt/absent storage
 * loads empty; state survives a simulated worker restart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AiNegativeMemoryStore } from '../../src/background/learning/ai-negative-memory';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function installChromeStub(): { localBacking: Map<string, unknown> } {
  const localBacking = new Map<string, unknown>();
  const sessionBacking = new Map<string, unknown>();
  const areaFor = (backing: Map<string, unknown>) => ({
    get: async (key: string) => ({ [key]: backing.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
    remove: async (key: string) => {
      backing.delete(key);
    },
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: areaFor(sessionBacking), local: areaFor(localBacking) },
  };
  return { localBacking };
}

async function makeStore(): Promise<AiNegativeMemoryStore> {
  const store = new AiNegativeMemoryStore();
  await store.load();
  return store;
}

describe('AiNegativeMemoryStore', () => {
  beforeEach(() => {
    installChromeStub();
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the gate open for the first two failures, then cools down for 1h on the third', async () => {
    const store = await makeStore();
    store.noteFailure('example.com', 'policy-rejected');
    store.noteFailure('example.com', 'stage-rejected:EXECUTOR_ERROR');
    expect(store.isCoolingDown('example.com')).toBe(false);

    store.noteFailure('example.com', 'no-action-selected');
    expect(store.isCoolingDown('example.com')).toBe(true);

    vi.setSystemTime(Date.now() + HOUR - 1);
    expect(store.isCoolingDown('example.com')).toBe(true);
    vi.setSystemTime(Date.now() + 2);
    expect(store.isCoolingDown('example.com')).toBe(false);
  });

  it('escalates 1h → 6h → 24h across consecutive failures', async () => {
    const store = await makeStore();
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) store.noteFailure('example.com', 'policy-rejected');
    const first = (store as unknown as { sites: Map<string, { cooldownUntil: number }> }).sites.get('example.com')!;
    expect(first.cooldownUntil - t0).toBe(HOUR);

    store.noteFailure('example.com', 'outcome-rollback');
    const second = (store as unknown as { sites: Map<string, { cooldownUntil: number }> }).sites.get('example.com')!;
    expect(second.cooldownUntil - t0).toBe(6 * HOUR);

    store.noteFailure('example.com', 'policy-rejected');
    store.noteFailure('example.com', 'policy-rejected');
    const capped = (store as unknown as { sites: Map<string, { cooldownUntil: number }> }).sites.get('example.com')!;
    expect(capped.cooldownUntil - t0).toBe(DAY);
  });

  it('noteSuccess wipes the failure streak and the cooldown', async () => {
    const store = await makeStore();
    for (let i = 0; i < 5; i++) store.noteFailure('example.com', 'outcome-rollback');
    expect(store.isCoolingDown('example.com')).toBe(true);

    store.noteSuccess('example.com');
    expect(store.isCoolingDown('example.com')).toBe(false);
    expect(store.count()).toBe(0);

    // A success with no failure memory is a no-op (keeps the map small).
    store.noteSuccess('never-failed.com');
    expect(store.count()).toBe(0);
  });

  it('decays the streak after 7 days of silence', async () => {
    const store = await makeStore();
    store.noteFailure('example.com', 'policy-rejected');
    store.noteFailure('example.com', 'policy-rejected');
    vi.setSystemTime(Date.now() + 7 * DAY + 1);

    store.noteFailure('example.com', 'policy-rejected');
    const memory = (store as unknown as { sites: Map<string, { consecutiveFailures: number }> }).sites.get('example.com')!;
    expect(memory.consecutiveFailures).toBe(1);
    expect(store.isCoolingDown('example.com')).toBe(false);
  });

  it('evicts the least-recently-failed site beyond 200 entries', async () => {
    const store = await makeStore();
    for (let i = 0; i < 200; i++) store.noteFailure(`site${i}.com`, 'policy-rejected');
    expect(store.count()).toBe(200);

    vi.setSystemTime(Date.now() + 1000);
    store.noteFailure('new-site.com', 'policy-rejected');
    expect(store.count()).toBe(200);
    const sites = (store as unknown as { sites: Map<string, unknown> }).sites;
    expect(sites.has('site0.com')).toBe(false); // oldest evicted
    expect(sites.has('new-site.com')).toBe(true);
    expect(sites.has('site199.com')).toBe(true);
  });

  it('tolerates corrupt and absent storage on load', async () => {
    const { localBacking } = installChromeStub();
    localBacking.set('adapt_ai_negative_memory_v1', { version: 1, sites: { 'bad.com': { nope: true } } });
    const store = new AiNegativeMemoryStore();
    await store.load();
    expect(store.count()).toBe(0);
    expect(store.isCoolingDown('bad.com')).toBe(false);

    // Mutations still work after a corrupt load.
    for (let i = 0; i < 3; i++) store.noteFailure('fresh.com', 'policy-rejected');
    expect(store.isCoolingDown('fresh.com')).toBe(true);
  });

  it('persists across a simulated worker restart', async () => {
    const { localBacking } = installChromeStub();
    const first = new AiNegativeMemoryStore();
    await first.load();
    for (let i = 0; i < 4; i++) first.noteFailure('example.com', 'stage-rejected:EXECUTOR_ERROR');
    await first.flush();
    expect(localBacking.has('adapt_ai_negative_memory_v1')).toBe(true);

    const second = new AiNegativeMemoryStore();
    await second.load();
    expect(second.isCoolingDown('example.com')).toBe(true);
    const memory = (second as unknown as { sites: Map<string, { consecutiveFailures: number }> }).sites.get('example.com')!;
    expect(memory.consecutiveFailures).toBe(4);
  });

  it('load is idempotent — a second load cannot clobber fresher in-memory state', async () => {
    const store = await makeStore();
    for (let i = 0; i < 3; i++) store.noteFailure('example.com', 'policy-rejected');
    await store.load(); // must be a no-op
    expect(store.isCoolingDown('example.com')).toBe(true);
  });

  it('ignores mutations before load and empty site keys', async () => {
    const store = new AiNegativeMemoryStore();
    store.noteFailure('example.com', 'policy-rejected'); // not loaded yet
    await store.load();
    expect(store.count()).toBe(0);
    store.noteFailure('', 'policy-rejected');
    expect(store.count()).toBe(0);
    expect(store.isCoolingDown('')).toBe(false);
  });
});
