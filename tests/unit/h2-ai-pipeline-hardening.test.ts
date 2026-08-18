/**
 * H2 hardening pins — AI pipeline defects found by deep recon:
 *
 *  A. RemotePlanner failure taxonomy (hermetic loopback HTTP, no credential):
 *     401/429/5xx distinct, non-JSON 200 = schema (not transport), >64KB body cap,
 *     abort = timeout, refused connection = transport, Azure finish_reason length =
 *     truncated (never reaches the validator).
 *  B. PolicyValidator bounds: action count cap, ADAPT-with-empty-actions, tier enum,
 *     prose array caps, NET_TEMP_BLOCK never mapped (no grammar-guarded parameter).
 *  C. Engine-path stampede guard: concurrent batches → one in-flight planner call;
 *     per-navigation budget ≤2.
 *  D. Orchestrator survivor-AI safety: stale-epoch abort after the planner await,
 *     repair transaction rolled back with its parent, pending timeout settles and
 *     rolls back, double-staging guards in both directions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { RemotePlanner, azureFinishReason } from '../../src/background/ai/remote-planner';
import { AI_STATUS_STORAGE_KEY, AiPlannerStatus } from '../../src/background/ai/status';
import { PolicyValidator } from '../../src/shared/ai/validator';
import { EvidencePacket } from '../../src/shared/ai/types';
import { AdaptationTransactionEngine } from '../../src/core/adaptation/engine';
import { DnrController } from '../../src/core/dnr/controller';
import { RecipeStore } from '../../src/core/recipes/store';
import { AuditStore } from '../../src/core/audit/store';
import { CausalOrchestrator } from '../../src/background/causal/orchestrator';
import { NavigationRegistry } from '../../src/core/navigation/registry';
import { EventGraphStore } from '../../src/background/causal/graph-store';
import { BeliefUpdater } from '../../src/background/causal/belief-updater';
import { PromotionGate } from '../../src/background/causal/promotion-gate';
import { EventNode } from '../../src/shared/causal/events';
import { HealthVector, PageSignalBatch, CausalPageObservationBatch, OpaqueSurvivorObservation } from '../../src/shared/types';

// ---- shared chrome.storage stub (status writes are read back for assertions) ----

let localBacking: Map<string, unknown>;
let sessionBacking: Map<string, unknown>;

function installChromeStub(): void {
  localBacking = new Map();
  sessionBacking = new Map();
  const areaFor = (backing: Map<string, unknown>) => ({
    get: async (key: string | string[]) => {
      if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => backing.has(k)).map((k) => [k, backing.get(k)]));
      return { [key]: backing.get(key) };
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
    remove: async (key: string) => { backing.delete(key); },
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: areaFor(sessionBacking), local: areaFor(localBacking) },
  };
}

const lastFailureClass = async (): Promise<string | undefined> => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const status = localBacking.get(AI_STATUS_STORAGE_KEY) as AiPlannerStatus | undefined;
  return status?.lastFailureClass;
};

const minimalEvidence = {
  schemaVersion: 1,
  transactionId: 'tx_test',
  navigationEpoch: 'nav_test',
  timestamp: Date.now(),
  siteContext: { originClass: 'publisher', pageTypeEstimate: 'unknown' },
  trigger: { reason: 'CONNECTION_TEST', confidence: 0.5 },
  healthBefore: {} as never,
  currentHealth: {} as never,
  observedReaction: { detectorTypes: [], antiBlockConfidence: 0.5, mutationBurstDetected: false },
  candidateElements: [],
  candidateRequests: [],
  availableActions: ['ABSTAIN'],
  knownConstraints: [],
  previousAttempts: [],
} as EvidencePacket;

// ---- A. RemotePlanner failure taxonomy -----------------------------------------

async function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/plan`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const validPlanBody = JSON.stringify({
  plan: {
    schemaVersion: 1,
    decision: 'ABSTAIN',
    hypothesis: { category: 'UNKNOWN', confidence: 0.5, explanation: 'relay' },
    selectedStrategyTier: 'ABSTAIN',
    actions: [],
    verification: { expectedHealthDelta: 0, maxWaitMs: 1000 },
    abortConditions: [],
    explanationCodes: [],
  },
});

describe('H2.A RemotePlanner failure taxonomy (hermetic)', () => {
  beforeEach(installChromeStub);

  it('classifies 401/429/5xx distinctly', async () => {
    for (const [status, expected] of [[401, 'http-401'], [429, 'http-429'], [503, 'http-5xx']] as const) {
      const server = await startServer((_req, res) => {
        res.writeHead(status).end();
      });
      const planner = new RemotePlanner({ endpoint: server.url, token: 'x' });
      await expect(planner.plan(minimalEvidence)).rejects.toThrow(`planner request failed: ${status}`);
      expect(await lastFailureClass()).toBe(expected);
      await server.close();
    }
  });

  it('a non-JSON 200 body is a schema failure, not transport', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>bad gateway page</body></html>');
    });
    const planner = new RemotePlanner({ endpoint: server.url });
    await expect(planner.plan(minimalEvidence)).rejects.toThrow('planner response body is not valid JSON');
    expect(await lastFailureClass()).toBe('schema');
    await server.close();
  });

  it('a response beyond the 64KB byte cap is rejected as schema/protocol violation', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ plan: { pad: 'x'.repeat(80 * 1024) } }));
    });
    const planner = new RemotePlanner({ endpoint: server.url });
    await expect(planner.plan(minimalEvidence)).rejects.toThrow('byte cap');
    expect(await lastFailureClass()).toBe('schema');
    await server.close();
  });

  it('an abort from the timeout is classified timeout', async () => {
    const server = await startServer(() => {
      // Never responds.
    });
    const planner = new RemotePlanner({ endpoint: server.url }, 800);
    await expect(planner.plan(minimalEvidence)).rejects.toThrow();
    expect(await lastFailureClass()).toBe('timeout');
    await server.close();
  }, 10_000);

  it('a refused connection is classified transport', async () => {
    const server = await startServer((_req, res) => res.writeHead(200).end(validPlanBody));
    const url = server.url;
    await server.close();
    const planner = new RemotePlanner({ endpoint: url });
    await expect(planner.plan(minimalEvidence)).rejects.toThrow();
    expect(await lastFailureClass()).toBe('transport');
  });

  it('a healthy 200 with a valid plan succeeds', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(validPlanBody);
    });
    const planner = new RemotePlanner({ endpoint: server.url });
    const plan = await planner.plan(minimalEvidence);
    expect(plan.decision).toBe('ABSTAIN');
    await server.close();
  });

  it('azureFinishReason detects token-cap truncation', () => {
    expect(azureFinishReason({ choices: [{ finish_reason: 'length', message: { content: '{"schemaV' } }] })).toBe('length');
    expect(azureFinishReason({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })).toBe('stop');
    expect(azureFinishReason({})).toBeUndefined();
  });

  it('Azure-shaped truncated completion is rejected before parsing and classified truncated', async () => {
    installChromeStub();
    // Hostname ends with .openai.azure.com so the Azure path runs; fetch is stubbed
    // hermetically — no network, no credential.
    const fetchStub = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"schemaVersion":1,"decision":"AD' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchStub);
    try {
      const planner = new RemotePlanner({ endpoint: 'https://adapt-unit.openai.azure.com/openai/deployments/gpt-x/chat/completions?api-version=2025-01-01', token: 'x' });
      await expect(planner.plan(minimalEvidence)).rejects.toThrow('truncated at token cap');
      expect(await lastFailureClass()).toBe('truncated');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---- B. PolicyValidator bounds ---------------------------------------------------

const healthVec: HealthVector = {
  antiBlockReaction: 0.6,
  contentAvailability: 1,
  interaction: 1,
  scrollability: 1,
  navigationHealth: 1,
  visualObstruction: 0.3,
  mutationStability: 1,
  networkIntegrity: 1,
  privacyPreservation: 1,
  confidence: 1,
};

function evidenceWith(actions: string[]): EvidencePacket {
  return {
    schemaVersion: 1,
    transactionId: 'tx_v',
    navigationEpoch: 'nav_v',
    timestamp: Date.now(),
    siteContext: { originClass: 'publisher', pageTypeEstimate: 'unknown' },
    trigger: { reason: 'REACTION_OBSERVED', confidence: 0.6 },
    healthBefore: healthVec,
    currentHealth: healthVec,
    observedReaction: { detectorTypes: [], antiBlockConfidence: 0.6, mutationBurstDetected: false },
    candidateElements: [{
      ref: 'element:e1',
      role: 'VISIBLE_AD_SURFACE',
      viewportCoverage: 0.3,
      isFixedOrAbsolute: true,
      hasHighZIndex: true,
      textSignals: [],
      interactionSuppressed: false,
    }],
    candidateRequests: [{
      ref: 'request:r1',
      urlDomain: 'redacted',
      resourceType: 'script',
      isBlockedByBaseline: false,
      failureObserved: false,
      thirdParty: true,
    }],
    availableActions: actions as EvidencePacket['availableActions'],
    knownConstraints: [],
    previousAttempts: [],
  };
}

function planWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    decision: 'ADAPT',
    hypothesis: { category: 'UNKNOWN', confidence: 0.8, explanation: 'test plan' },
    selectedStrategyTier: 'S3',
    actions: [{ actionType: 'DOM_REMOVE_OVERLAY', targetRef: 'element:e1', parameter: '' }],
    verification: { expectedHealthDelta: 0.1, maxWaitMs: 1000 },
    abortConditions: [],
    explanationCodes: [],
    ...overrides,
  };
}

describe('H2.B PolicyValidator bounds', () => {
  const validator = new PolicyValidator();

  it('rejects plans with more than 4 actions', () => {
    const actions = Array.from({ length: 5 }, () => ({ actionType: 'DOM_REMOVE_OVERLAY', targetRef: 'element:e1', parameter: '' }));
    const result = validator.validate(evidenceWith(['DOM_REMOVE_OVERLAY']), planWith({ actions }));
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toContain('exceeds 4');
  });

  it('rejects ADAPT with an empty actions array; ABSTAIN with empty stays valid', () => {
    const adapt = validator.validate(evidenceWith(['ABSTAIN']), planWith({ actions: [] }));
    expect(adapt.valid).toBe(false);
    expect(adapt.reasons.join(' ')).toContain('empty actions');
    const abstain = validator.validate(evidenceWith(['ABSTAIN']), planWith({ decision: 'ABSTAIN', actions: [], selectedStrategyTier: 'ABSTAIN' }));
    expect(abstain.valid).toBe(true);
  });

  it('rejects an out-of-enum selectedStrategyTier', () => {
    const result = validator.validate(evidenceWith(['DOM_REMOVE_OVERLAY']), planWith({ selectedStrategyTier: 'S9' }));
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toContain('selectedStrategyTier');
  });

  it('rejects oversized prose arrays', () => {
    const result = validator.validate(evidenceWith(['DOM_REMOVE_OVERLAY']), planWith({
      abortConditions: Array.from({ length: 9 }, (_, i) => `condition ${i}`),
    }));
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toContain('abortConditions');
  });

  it('never maps NET_TEMP_BLOCK into a DNR action, even when offered and proposed', () => {
    const result = validator.validate(
      evidenceWith(['NET_TEMP_BLOCK', 'ABSTAIN']),
      planWith({ actions: [{ actionType: 'NET_TEMP_BLOCK', targetRef: '', parameter: '*' }] })
    );
    expect(result.valid).toBe(true); // allowed action, but…
    expect(result.mappedStrategyActions?.filter((a) => a.type === 'NET_BLOCK')).toEqual([]);
  });
});

// ---- C. Engine stampede guard ------------------------------------------------------

function ambiguousBatch(navigationId: string): PageSignalBatch {
  return {
    navigationId,
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
}

describe('H2.C engine-path planner stampede guard', () => {
  beforeEach(installChromeStub);

  function makeEngine() {
    const storage = {
      data: {} as Record<string, unknown>,
      get: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, (storage.data as Record<string, unknown>)[k]])),
      set: async (items: Record<string, unknown>) => { Object.assign(storage.data, items); },
      remove: async (keys: string[]) => { for (const k of keys) delete (storage.data as Record<string, unknown>)[k]; },
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
    return engine;
  }

  const abstainPlanner = () => {
    let calls = 0;
    return {
      calls: () => calls,
      plan: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          schemaVersion: 1,
          decision: 'ABSTAIN',
          hypothesis: { category: 'UNKNOWN', confidence: 0.5, explanation: 'ambiguous, abstain' },
          selectedStrategyTier: 'ABSTAIN',
          actions: [],
          verification: { expectedHealthDelta: 0, maxWaitMs: 500 },
          abortConditions: [],
          explanationCodes: [],
        };
      },
    };
  };

  it('a burst of concurrent batches on one navigation spends exactly one planner call', async () => {
    const engine = makeEngine();
    const planner = abstainPlanner();
    engine.setAdaptivePlanner(planner as never);
    const results = await Promise.all([
      engine.evaluateSignals(1, 'nav_burst', 'news.test', ambiguousBatch('nav_burst')),
      engine.evaluateSignals(1, 'nav_burst', 'news.test', ambiguousBatch('nav_burst')),
      engine.evaluateSignals(1, 'nav_burst', 'news.test', ambiguousBatch('nav_burst')),
      engine.evaluateSignals(1, 'nav_burst', 'news.test', ambiguousBatch('nav_burst')),
      engine.evaluateSignals(1, 'nav_burst', 'news.test', ambiguousBatch('nav_burst')),
    ]);
    expect(results.every((r) => r === null)).toBe(true); // ABSTAIN → no candidate
    expect(planner.calls()).toBe(1);
  });

  it('the per-navigation budget caps sequential planner calls at 2', async () => {
    const engine = makeEngine();
    const planner = abstainPlanner();
    engine.setAdaptivePlanner(planner as never);
    for (let i = 0; i < 4; i++) {
      await engine.evaluateSignals(2, 'nav_seq', 'news.test', ambiguousBatch('nav_seq'));
    }
    expect(planner.calls()).toBe(2);
  });
});

// ---- D. Orchestrator survivor-AI safety ---------------------------------------------

const orchHealth: HealthVector = {
  antiBlockReaction: 0.55,
  contentAvailability: 1,
  interaction: 1,
  scrollability: 1,
  navigationHealth: 1,
  visualObstruction: 0.4,
  mutationStability: 1,
  networkIntegrity: 1,
  privacyPreservation: 1,
  confidence: 1,
};

function survivor(): OpaqueSurvivorObservation {
  return {
    ref: 'survivor:s1',
    class: 'ANTI_BLOCK_REACTION',
    documentScope: 'doc',
    observedAt: Date.now(),
    confidence: 0.8,
    evidenceClasses: ['VISIBLE_AD_CANDIDATE'],
    elementRef: 'element:e1',
    protectedContext: { authOrPayment: false, media: false, downloadOrDocument: false, userIntentRelated: false },
    features: {
      visible: true, thirdPartyResource: true, fixedOrAbsolute: true, isolatedSurface: true,
      semanticAdLabel: false, recentInsertion: true, mutationAssociation: 1, viewportCoverage: 0.3,
    },
  };
}

function makeOrchestrator(plannerBehavior: 'resolve' | 'navigate-during-plan') {
  const registry = new NavigationRegistry();
  const graphs = new EventGraphStore();
  const executorCalls = {
    stage: [] as Array<{ txId: string; primitiveId: string }>,
    rollback: [] as string[],
    hydrate: [] as Array<{ txId: string }>,
  };
  const executors = {
    stage: async (input: { txId: string; primitiveId: string }) => {
      executorCalls.stage.push({ txId: input.txId, primitiveId: input.primitiveId });
      return { ok: true as const };
    },
    rollback: async (txId: string) => {
      executorCalls.rollback.push(txId);
      return { ok: true as const };
    },
    get: (txId: string) => ({
      txId,
      primitiveId: 'TARGETED_SESSION_DNR',
      tabId: 7,
      frameId: 0,
      documentId: 'doc-1',
      opaqueRefs: ['request:r1'],
      sessionRuleIds: [910001],
      domActionIds: [],
      startedWallMs: Date.now(),
      committed: false,
    }),
    hydrate: (record: { txId: string }) => {
      executorCalls.hydrate.push({ txId: record.txId });
    },
  };
  const planner = {
    calls: 0,
    plan: async () => {
      planner.calls++;
      if (plannerBehavior === 'navigate-during-plan') {
        // The user navigates away while the model is thinking.
        registry.onNavigationCommitted(7, 0, 'https://site-a.test/away', undefined, 'doc-2');
      }
      return {
        schemaVersion: 1,
        decision: 'ADAPT',
        hypothesis: { category: 'UNKNOWN', confidence: 0.85, explanation: 'survivor attribution' },
        selectedStrategyTier: 'S3',
        actions: [{ actionType: 'TARGETED_SESSION_DNR', targetRef: 'request:r1', parameter: '' }],
        verification: { expectedHealthDelta: 0.1, maxWaitMs: 1000 },
        abortConditions: [],
        explanationCodes: [],
      };
    },
  };
  const orchestrator = new CausalOrchestrator({
    registry,
    requestGraphs: { getGraph: () => undefined } as never,
    graphs,
    beliefs: new BeliefUpdater(),
    engine: { getRecords: () => [] } as never,
    session: { persist: async () => {}, persistSoon: () => {} } as never,
    sendTabMessage: async () => {},
    recipeStore: { getRecipe: async () => undefined } as never,
    promotion: new PromotionGate(),
    primitiveExecutors: executors as never,
    runFallback: async () => null,
  });
  orchestrator.setAdaptivePlanner(planner as never);
  return { registry, graphs, orchestrator, executors, executorCalls, planner };
}

function seedNavigationFixture(registry: NavigationRegistry, graphs: EventGraphStore) {
  const epoch = registry.onNavigationCommitted(7, 0, 'https://site-a.test/page', undefined, 'doc-1');
  const scope = registry.getCausalKey(7, 0)!;
  const graph = graphs.getOrCreate(scope, 'deadbeef');
  const requestNode = (id: string, ref: string, host: string): EventNode => ({
    id,
    kind: 'REQUEST_COMPLETE',
    scope: { ...scope, frameId: 0 },
    timestamp: { value: Date.now(), wallMs: Date.now(), monotonicMs: 1 } as never,
    refs: [ref as `request:r${number}`],
    features: { thirdParty: true, resourceType: 'script', hostname: host },
  } as unknown as EventNode);
  graph.nodes.push(requestNode('event:n1', 'request:r1', 'ads-cdn.test'));
  graph.nodes.push(requestNode('event:n2', 'request:r2', 'tracker.test'));
  const batch: CausalPageObservationBatch = {
    timestamp: Date.now(),
    pageSignals: ambiguousBatch('nav_orch'),
    elements: [],
    survivors: [survivor()],
  };
  return { epoch, scope, graph, batch };
}

type SurvivorAiRunner = {
  maybeRunSurvivorAi: (
    tabId: number, frameId: number,
    epoch: NonNullable<ReturnType<NavigationRegistry['getEpoch']>>,
    scope: NonNullable<ReturnType<NavigationRegistry['getCausalKey']>>,
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    batch: CausalPageObservationBatch,
    health: HealthVector
  ) => Promise<void>;
  maybeRun: (
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    siteKey: string, navigationId: string, baselineHealth: HealthVector, force?: boolean
  ) => Promise<boolean>;
  pendingSurvivorAi: Map<string, { documentId: string; repairTxId?: string }>;
  pendingAutonomy: Map<string, { graphId: string }>;
};

describe('H2.D orchestrator survivor-AI safety', () => {
  beforeEach(installChromeStub);
  afterEach(() => vi.useRealTimers());

  it('aborts staging when the document navigated during the planner call', async () => {
    const { registry, graphs, orchestrator, executorCalls, planner } = makeOrchestrator('navigate-during-plan');
    const { epoch, scope, graph, batch } = seedNavigationFixture(registry, graphs);
    const runner = orchestrator as unknown as SurvivorAiRunner;
    await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, batch, orchHealth);
    expect(planner.calls).toBe(1); // the budget was spent…
    expect(executorCalls.stage).toEqual([]); // …but nothing was staged from stale evidence
    const trace = orchestrator.getSurvivorAiTrace()[0];
    expect(trace?.executorResult).toBe('aborted-stale-epoch');
  });

  it('stages survivor + repair on the live epoch and rolls BOTH back on a health regression', async () => {
    const { registry, graphs, orchestrator, executorCalls } = makeOrchestrator('resolve');
    const { epoch, scope, graph, batch } = seedNavigationFixture(registry, graphs);
    const runner = orchestrator as unknown as SurvivorAiRunner;
    await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, batch, orchHealth);
    expect(executorCalls.stage.map((c) => c.primitiveId)).toEqual(['TARGETED_SESSION_DNR', 'REMOVE_REACTION_UI']);
    const txId = executorCalls.stage[0]!.txId;
    expect(runner.pendingSurvivorAi.get(txId)?.repairTxId).toBe(`${txId}_repair`);

    const badHealth: HealthVector = { ...orchHealth, contentAvailability: 0.3, interaction: 0.2 };
    const handled = await orchestrator.onHealthSnapshot(7, 0, txId, badHealth);
    expect(handled).toBe(true);
    expect(executorCalls.rollback).toContain(txId);
    expect(executorCalls.rollback).toContain(`${txId}_repair`);
    expect(runner.pendingSurvivorAi.has(txId)).toBe(false);
  });

  it('a health reply from a DIFFERENT document does not settle the transaction', async () => {
    const { registry, graphs, orchestrator, executorCalls } = makeOrchestrator('resolve');
    const { epoch, scope, graph, batch } = seedNavigationFixture(registry, graphs);
    const runner = orchestrator as unknown as SurvivorAiRunner;
    await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, batch, orchHealth);
    const txId = executorCalls.stage[0]!.txId;

    // Tab navigates before the snapshot reply lands — the reply now describes doc-2.
    registry.onNavigationCommitted(7, 0, 'https://site-a.test/away', undefined, 'doc-2');
    const handled = await orchestrator.onHealthSnapshot(7, 0, txId, orchHealth);
    expect(handled).toBe(true); // swallowed, not settled
    expect(runner.pendingSurvivorAi.has(txId)).toBe(true); // still pending → timeout owns it
    expect(executorCalls.rollback).toEqual([]);
  });

  it('the pending timeout settles an unverifiable transaction and rolls back both legs', async () => {
    vi.useFakeTimers();
    const { registry, graphs, orchestrator, executorCalls } = makeOrchestrator('resolve');
    const { epoch, scope, graph, batch } = seedNavigationFixture(registry, graphs);
    const runner = orchestrator as unknown as SurvivorAiRunner;
    const run = runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, batch, orchHealth);
    await vi.advanceTimersByTimeAsync(300); // the post-stage 250ms observation sleep
    await run;
    const txId = executorCalls.stage[0]!.txId;
    expect(runner.pendingSurvivorAi.has(txId)).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(runner.pendingSurvivorAi.has(txId)).toBe(false);
    expect(executorCalls.rollback).toContain(txId);
    expect(executorCalls.rollback).toContain(`${txId}_repair`);
    const trace = orchestrator.getSurvivorAiTrace()[0];
    expect(trace?.executorResult).toBe('timeout-unverified-rollback');
  });

  it('double-staging guards: pending survivor blocks autonomy, pending autonomy blocks survivor AI', async () => {
    const { registry, graphs, orchestrator, executorCalls } = makeOrchestrator('resolve');
    const { epoch, scope, graph, batch } = seedNavigationFixture(registry, graphs);
    const runner = orchestrator as unknown as SurvivorAiRunner;

    // Direction 1: survivor pending → autonomy stands down.
    await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, batch, orchHealth);
    expect(executorCalls.stage.length).toBeGreaterThan(0);
    const stageCount = executorCalls.stage.length;
    const autonomyResult = await runner.maybeRun(graph, 'site-a.test', epoch.navigationId, orchHealth, true);
    expect(autonomyResult).toBe(true);
    expect(executorCalls.stage.length).toBe(stageCount);

    // Direction 2: autonomy pending → survivor AI never spends a planner call.
    const { registry: r2, graphs: g2, orchestrator: o2, planner: p2 } = makeOrchestrator('resolve');
    const fixture2 = seedNavigationFixture(r2, g2);
    const runner2 = o2 as unknown as SurvivorAiRunner;
    runner2.pendingAutonomy.set('tx_auto_1', { graphId: fixture2.graph.graphId });
    await runner2.maybeRunSurvivorAi(7, 0, fixture2.epoch, fixture2.scope, fixture2.graph, fixture2.batch, orchHealth);
    expect(p2.calls).toBe(0);
  });

  it('skips the companion repair for an unlabeled VISIBLE_AD_SURFACE (target.com class)', async () => {
    const { registry, graphs, orchestrator, executorCalls } = makeOrchestrator('resolve');
    const { epoch, scope, graph, batch } = seedNavigationFixture(registry, graphs);
    // The default class: every unlabeled visible element. Hiding it means hiding
    // arbitrary content (product tiles), so no companion repair may be staged.
    batch.survivors = [{ ...survivor(), class: 'VISIBLE_AD_SURFACE' }];
    const runner = orchestrator as unknown as SurvivorAiRunner;
    await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, batch, orchHealth);
    expect(executorCalls.stage.map((c) => c.primitiveId)).toEqual(['TARGETED_SESSION_DNR']);
    const txId = executorCalls.stage[0]!.txId;
    expect(runner.pendingSurvivorAi.get(txId)?.repairTxId).toBeUndefined();
  });

  it('worker restart settles staged transactions: hydrate, roll back both legs, clear the store', async () => {
    const { registry, graphs, orchestrator, executorCalls } = makeOrchestrator('resolve');
    const { epoch, scope, graph, batch } = seedNavigationFixture(registry, graphs);
    const runner = orchestrator as unknown as SurvivorAiRunner;
    await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, batch, orchHealth);
    const txId = executorCalls.stage[0]!.txId;
    await new Promise((resolve) => setTimeout(resolve, 10)); // flush the pending-write chain

    const stored = sessionBacking.get('adapt_survivor_ai_pending_v1') as Array<{ txId: string; repairTxId?: string; executions: Array<{ txId: string }> }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.txId).toBe(txId);
    expect(stored[0]!.repairTxId).toBe(`${txId}_repair`);
    expect(stored[0]!.executions.length).toBeGreaterThan(0);

    // A NEW worker: the in-memory pending map and settle timers are gone, the
    // executor's staged map is empty — only the snapshot survives.
    const { orchestrator: revived, executorCalls: revivedCalls } = makeOrchestrator('resolve');
    await revived.restoreSurvivorAiPending();
    expect(revivedCalls.hydrate.map((r) => r.txId)).toContain(txId);
    expect(revivedCalls.rollback).toContain(txId);
    expect(revivedCalls.rollback).toContain(`${txId}_repair`);
    const cleared = sessionBacking.get('adapt_survivor_ai_pending_v1') as unknown[];
    expect(cleared).toEqual([]);
  });
});
