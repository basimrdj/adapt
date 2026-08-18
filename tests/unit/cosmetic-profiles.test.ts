import { describe, it, expect, beforeEach } from 'vitest';
import { CosmeticProfileStore } from '../../src/background/learning/cosmetic-profiles';

/**
 * In-memory chrome.storage.local stub — the store under test only touches
 * storage.local.get/set.
 */
function installChromeStub(): { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: data.get(key) }),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) data.set(key, value);
        },
      },
    },
  };
  return { data };
}

const PAGE = 'https://shop.example.com/article/1';
const OTHER_PAGE = 'https://news.example.net/story';

describe('CosmeticProfileStore (Phase E)', () => {
  beforeEach(() => {
    installChromeStub();
  });

  it('learns hides only after a verified-healthy confirm', async () => {
    const store = new CosmeticProfileStore();
    await store.load();
    store.noteAppliedHides('tx1', PAGE, ['div.sponsored-widget']);
    expect(store.replayFor(PAGE)).toEqual([]); // pending is not replayable
    expect(store.confirmHides('tx1')).toBe(1);
    expect(store.replayFor(PAGE)).toEqual(['div.sponsored-widget']);
  });

  it('discards rolled-back hides so they are never persisted', async () => {
    const store = new CosmeticProfileStore();
    await store.load();
    store.noteAppliedHides('tx1', PAGE, ['div.sponsored-widget']);
    store.discardHides('tx1');
    expect(store.confirmHides('tx1')).toBe(0);
    expect(store.replayFor(PAGE)).toEqual([]);
  });

  it('rejects selectors outside the stable grammar', async () => {
    const store = new CosmeticProfileStore();
    await store.load();
    store.noteAppliedHides('tx1', PAGE, [
      'div:nth-child(2)',
      'div > .ad',
      'div[class*="x"]',
      'div.sponsored-widget {} body { display:none }',
      'not-a-selector!!',
    ]);
    expect(store.confirmHides('tx1')).toBe(0);
    store.noteAppliedHides('tx2', PAGE, ['#sponsored-box', 'aside.ad-card.wide']);
    expect(store.confirmHides('tx2')).toBe(2);
    expect(store.replayFor(PAGE).sort()).toEqual(['#sponsored-box', 'aside.ad-card.wide']);
  });

  it('drops a rule after repeated broke reports (rollback guard)', async () => {
    const store = new CosmeticProfileStore();
    await store.load();
    store.noteAppliedHides('tx1', PAGE, ['div.sponsored-widget']);
    store.confirmHides('tx1');
    for (let i = 0; i < 3; i++) {
      store.noteReplayOutcome(PAGE, true, ['div.sponsored-widget'], []);
    }
    expect(store.replayFor(PAGE)).toEqual([]);
  });

  it('passes protect a rule from the failure drop', async () => {
    const store = new CosmeticProfileStore();
    await store.load();
    store.noteAppliedHides('tx1', PAGE, ['div.sponsored-widget']);
    store.confirmHides('tx1');
    // Three healthy replays, then three broke reports: failures must EXCEED
    // passes before the guard drops the rule.
    for (let i = 0; i < 3; i++) store.noteReplayOutcome(PAGE, false, ['div.sponsored-widget'], []);
    for (let i = 0; i < 3; i++) store.noteReplayOutcome(PAGE, true, ['div.sponsored-widget'], []);
    expect(store.replayFor(PAGE)).toEqual(['div.sponsored-widget']);
    for (let i = 0; i < 2; i++) store.noteReplayOutcome(PAGE, true, ['div.sponsored-widget'], []);
    expect(store.replayFor(PAGE)).toEqual([]);
  });

  it('drops stale rules after consecutive misses', async () => {
    const store = new CosmeticProfileStore();
    await store.load();
    store.noteAppliedHides('tx1', PAGE, ['div.sponsored-widget']);
    store.confirmHides('tx1');
    for (let i = 0; i < 5; i++) {
      store.noteReplayOutcome(PAGE, false, [], ['div.sponsored-widget']);
    }
    expect(store.replayFor(PAGE)).toEqual([]);
  });

  it('persists across a simulated restart (fresh store, same storage)', async () => {
    const first = new CosmeticProfileStore();
    await first.load();
    first.noteAppliedHides('tx1', PAGE, ['div.sponsored-widget']);
    first.confirmHides('tx1');
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the immediate flush land

    const second = new CosmeticProfileStore();
    await second.load();
    expect(second.replayFor(PAGE)).toEqual(['div.sponsored-widget']);
    expect(second.replayFor(OTHER_PAGE)).toEqual([]);
  });

  it('scopes profiles per registrable site', async () => {
    const store = new CosmeticProfileStore();
    await store.load();
    store.noteAppliedHides('tx1', PAGE, ['div.sponsored-widget']);
    store.confirmHides('tx1');
    expect(store.replayFor('https://www.example.com/other')).toEqual(['div.sponsored-widget']);
    expect(store.replayFor(OTHER_PAGE)).toEqual([]);
  });
});
