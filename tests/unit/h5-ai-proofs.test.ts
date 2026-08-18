/**
 * H5 — AI + privacy executable proofs (unit/hermetic tier):
 *
 *  A. Cooldown semantics pinned: an EXPIRED cooldown preserves the failure
 *     streak (next failure escalates the ladder — the honest reading: detectors
 *     don't reset just because the clock ran out); a success after expiry still
 *     wipes the memory; the ENGINE path consults the same cooldown before any
 *     planner spend.
 *  B. Mock-planner production guard: the production wiring assertion accepts a
 *     real RemotePlanner and throws on anything else — a mock/stub/double in
 *     the production path is a wiring bug and must fail loud.
 *  C. Connection-test loopback coverage: 401 vs 429 vs 500 are distinct
 *     user-visible classes; a hung endpoint is a timeout; malformed JSON on a
 *     200 is a schema fault; a plan referencing foreign refs fails the same
 *     production PolicyValidator the live path uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { AiNegativeMemoryStore } from '../../src/background/learning/ai-negative-memory';
import { assertProductionPlanner, RemotePlanner } from '../../src/background/ai/remote-planner';
import { runPlannerConnectionTest, buildConnectionTestPacket, TEST_REQUEST_REFS } from '../../src/background/ai/test-connection';
import { registrableDomain } from '../../src/shared/resource-identity';
import { AdaptationTransactionEngine } from '../../src/core/adaptation/engine';
import { DnrController } from '../../src/core/dnr/controller';
import { RecipeStore } from '../../src/core/recipes/store';
import { AuditStore } from '../../src/core/audit/store';
import { PageSignalBatch } from '../../src/shared/types';

const HOUR = 60 * 60 * 1000;

function installChromeStub(): void {
  const localBacking = new Map<string, unknown>();
  const sessionBacking = new Map<string, unknown>();
  const areaFor = (backing: Map<string, unknown>) => ({
    get: async (key: string | string[]) => {
      if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => backing.has(k)).map((k) => [k, backing.get(k)]));
      return { [key]: backing.get(key) };
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
    remove: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) backing.delete(k);
    },
    clear: async () => backing.clear(),
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: areaFor(sessionBacking), local: areaFor(localBacking) },
  };
}

// ---- A. Cooldown semantics ----------------------------------------------------

describe('H5.A cooldown semantics', () => {
  beforeEach(() => {
    installChromeStub();
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('an expired cooldown preserves the streak — the next failure escalates the ladder', async () => {
    const store = new AiNegativeMemoryStore();
    await store.load();
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) store.noteFailure('example.com', 'policy-rejected');
    expect(store.isCoolingDown('example.com')).toBe(true);

    // Let the 1h cooldown expire (well inside the 7-day decay window).
    vi.setSystemTime(t0 + HOUR + 1);
    expect(store.isCoolingDown('example.com')).toBe(false);

    // The streak survived expiry: this is failure #4 → 6h, not a fresh start.
    store.noteFailure('example.com', 'outcome-rollback');
    const memory = (store as unknown as { sites: Map<string, { consecutiveFailures: number; cooldownUntil: number }> })
      .sites.get('example.com')!;
    expect(memory.consecutiveFailures).toBe(4);
    expect(memory.cooldownUntil - (t0 + HOUR + 1)).toBe(6 * HOUR);
    expect(store.isCoolingDown('example.com')).toBe(true);
  });

  it('a success after cooldown expiry still wipes the memory entirely', async () => {
    const store = new AiNegativeMemoryStore();
    await store.load();
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) store.noteFailure('example.com', 'policy-rejected');
    vi.setSystemTime(t0 + HOUR + 1); // cooldown expired
    expect(store.isCoolingDown('example.com')).toBe(false);

    store.noteSuccess('example.com');
    expect(store.count()).toBe(0);
    // And the next failure starts a clean streak — no ghost escalation.
    store.noteFailure('example.com', 'policy-rejected');
    const memory = (store as unknown as { sites: Map<string, { consecutiveFailures: number }> }).sites.get('example.com')!;
    expect(memory.consecutiveFailures).toBe(1);
    expect(store.isCoolingDown('example.com')).toBe(false);
  });

  it('engine path: a cooling-down site never reaches the planner; cooldown lift restores it', async () => {
    vi.useRealTimers(); // engine planner stub uses real timers
    const storage = {
      data: {} as Record<string, unknown>,
      get: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, storage.data[k]])),
      set: async (items: Record<string, unknown>) => { Object.assign(storage.data, items); },
      remove: async (keys: string[]) => { for (const k of keys) delete storage.data[k]; },
    };
    const dnrBackend = {
      getDynamicRules: async () => [] as chrome.declarativeNetRequest.Rule[],
      getSessionRules: async () => [] as chrome.declarativeNetRequest.Rule[],
      updateDynamicRules: async () => {},
      updateSessionRules: async () => {},
    };
    const engine = new AdaptationTransactionEngine(
      new DnrController(dnrBackend),
      new RecipeStore(storage),
      new AuditStore(storage),
      storage,
      async () => {}
    );
    let plannerCalls = 0;
    engine.setAdaptivePlanner({
      plan: async () => {
        plannerCalls++;
        return {
          schemaVersion: 1,
          decision: 'ABSTAIN',
          hypothesis: { category: 'UNKNOWN', confidence: 0.5, explanation: 'x' },
          selectedStrategyTier: 'ABSTAIN',
          actions: [],
          verification: { expectedHealthDelta: 0, maxWaitMs: 500 },
          abortConditions: [],
          explanationCodes: [],
        };
      },
    } as never);

    let cooling = true;
    engine.setAiNegativeMemory({ isCoolingDown: () => cooling, noteFailure: () => {}, noteSuccess: () => {} });

    const batch: PageSignalBatch = {
      navigationId: 'nav_cool',
      timestamp: Date.now(),
      geometry: {
        viewportWidth: 1024, viewportHeight: 768, hasFixedOverlay: false, overlayCoverageRatio: 0,
        bodyScrollLocked: false, htmlScrollLocked: false, modalCount: 0, mainContentHidden: false, mainContentHeight: 1200,
      },
      semantic: { detectedPhrases: ['we noticed you are using an ad blocker'], adblockKeywordDensity: 0.06, confidenceScore: 0.92 },
      interaction: { pointerEventsSuppressed: false, bodyOverflowHidden: false, contentCovered: false },
      mutation: { mutationRatePerSecond: 3, rapidReinsertionDetected: false, overlayReinsertedCount: 0, degradationState: 'NORMAL' },
      suspectedDetectorTypes: ['POPUP_REACTION'],
    };

    await engine.evaluateSignals(1, 'nav_cool', 'news.test', batch);
    await engine.evaluateSignals(1, 'nav_cool', 'news.test', { ...batch, timestamp: Date.now() + 1 });
    expect(plannerCalls).toBe(0); // cooldown gated before any planner spend

    cooling = false;
    await engine.evaluateSignals(1, 'nav_cool', 'news.test', { ...batch, timestamp: Date.now() + 2 });
    expect(plannerCalls).toBe(1);
  });
});

// ---- B. Mock-planner production guard -----------------------------------------

describe('H5.B production planner guard', () => {
  it('accepts a real RemotePlanner and undefined (unconfigured)', () => {
    expect(() => assertProductionPlanner(undefined)).not.toThrow();
    expect(() =>
      assertProductionPlanner(new RemotePlanner({ endpoint: 'https://planner.example.com/v1/plan' }))
    ).not.toThrow();
  });

  it('throws on a mock-shaped planner in the production wiring path', () => {
    const mock = { plannerKind: 'mock', plan: async () => ({}) };
    expect(() => assertProductionPlanner(mock as never)).toThrow(/RemotePlanner/);
    const functionPlanner = { plan: async () => ({}) };
    expect(() => assertProductionPlanner(functionPlanner as never)).toThrow(/RemotePlanner/);
  });
});

// ---- C. Connection-test loopback coverage --------------------------------------

describe('H5.C connection-test loopback', () => {
  beforeEach(installChromeStub);

  async function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}/plan`, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  const abstainPlanBody = JSON.stringify({
    plan: {
      schemaVersion: 1,
      decision: 'ABSTAIN',
      hypothesis: { category: 'UNKNOWN', confidence: 0.5, explanation: 'connection test' },
      selectedStrategyTier: 'ABSTAIN',
      actions: [],
      verification: { expectedHealthDelta: 0, maxWaitMs: 1000 },
      abortConditions: [],
      explanationCodes: [],
    },
  });

  it('401, 429, and 500 surface as distinct user-visible classes', async () => {
    for (const status of [401, 429, 500] as const) {
      const { url, close } = await startServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{}');
      });
      try {
        const result = await runPlannerConnectionTest({ endpoint: url });
        expect(result.providerReached).toBe(false);
        expect(result.errorClass).toBe(`http-${status}`);
      } finally {
        await close();
      }
    }
  });

  it('a hung endpoint surfaces as timeout', async () => {
    const { url, close } = await startServer(() => {
      // Never respond — the planner's AbortController must cut this off.
    });
    try {
      const result = await runPlannerConnectionTest({ endpoint: url, timeoutMs: 1_000 });
      expect(result.providerReached).toBe(false);
      expect(result.errorClass).toBe('timeout');
      expect(result.latencyMs).not.toBeNull();
      expect(result.latencyMs!).toBeLessThan(10_000);
    } finally {
      await close();
    }
  }, 20_000);

  it('malformed JSON on a 200 is a schema fault, not transport', async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"plan": ');
    });
    try {
      const result = await runPlannerConnectionTest({ endpoint: url });
      expect(result.providerReached).toBe(false);
      expect(result.errorClass).toBe('schema');
    } finally {
      await close();
    }
  });

  it('a valid ABSTAIN through the production validator reaches providerReached+schemaValid', async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(abstainPlanBody);
    });
    try {
      const result = await runPlannerConnectionTest({ endpoint: url });
      expect(result.providerReached).toBe(true);
      expect(result.schemaValid).toBe(true);
      expect(result.decision).toBe('ABSTAIN');
    } finally {
      await close();
    }
  });

  it('a plan referencing refs outside the test packet fails production policy', async () => {
    const foreignPlan = JSON.stringify({
      plan: {
        schemaVersion: 1,
        decision: 'ADAPT',
        hypothesis: { category: 'OVERLAY', confidence: 0.9, explanation: 'x' },
        selectedStrategyTier: 'S1',
        actions: [{ actionType: 'TARGETED_SESSION_DNR', targetRef: 'request:r1', parameter: '' }],
        verification: { expectedHealthDelta: 0.2, maxWaitMs: 1000 },
        abortConditions: [],
        explanationCodes: [],
      },
    });
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(foreignPlan);
    });
    try {
      const result = await runPlannerConnectionTest({ endpoint: url });
      expect(result.providerReached).toBe(true);
      expect(result.schemaValid).toBe(false);
      expect(result.errorClass).toBe('schema');
    } finally {
      await close();
    }
  });

  it('the test packet itself ships only the pinned synthetic refs and redacted domains', () => {
    const packet = buildConnectionTestPacket();
    const serialized = JSON.stringify(packet);
    expect(packet.candidateRequests.map((c) => c.ref)).toEqual([...TEST_REQUEST_REFS]);
    expect(packet.candidateRequests.every((c) => c.urlDomain === 'redacted')).toBe(true);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toContain('localhost');
    expect(packet.trigger.reason).toBe('CONNECTION_TEST');
  });
});

// ---- D. registrableDomain (privacy hints + learning buckets) -----------------

describe('H5.D registrableDomain compound public suffixes', () => {
  it('keeps three labels for compound suffixes, two for simple TLDs', () => {
    expect(registrableDomain('pixel.tracker-example.co.uk')).toBe('tracker-example.co.uk');
    expect(registrableDomain('a.b.cdn-example.com')).toBe('cdn-example.com');
    expect(registrableDomain('www.shop-example.com.au')).toBe('shop-example.com.au');
    expect(registrableDomain('host.example.co.jp')).toBe('example.co.jp');
    // The suffix itself never collapses further.
    expect(registrableDomain('co.uk')).toBe('co.uk');
    expect(registrableDomain('example.com')).toBe('example.com');
    // IP literals pass through untouched.
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1');
  });
});
