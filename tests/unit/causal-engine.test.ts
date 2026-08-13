import { describe, it, expect } from 'vitest';
import { CausalEngine, CausalRunContext } from '../../src/background/causal/causal-engine';
import { EventGraphStore } from '../../src/background/causal/graph-store';
import { experimentToStrategy } from '../../src/background/causal/experiment-to-strategy';
import { AdaptationTransactionEngine } from '../../src/core/adaptation/engine';
import { AdaptationRollbackHandler } from '../../src/core/adaptation/rollback';
import { AuditStore } from '../../src/core/audit/store';
import { DnrBackend, DnrController } from '../../src/core/dnr/controller';
import { NavigationRegistry } from '../../src/core/navigation/registry';
import { RecipeStore, StorageBackend } from '../../src/core/recipes/store';
import { hashOrigin } from '../../src/shared/causal/events';
import {
  CurrentEpochState,
  ExperimentCandidate,
  STRATEGY_REF_ALLOWLIST,
} from '../../src/shared/causal/experiments';
import {
  AdaptationTransaction,
  HealthVector,
  StrategyCandidate,
} from '../../src/shared/types';

const ORIGIN = 'https://news.example';
const ORIGIN_HASH = hashOrigin(ORIGIN);
const SITE_KEY = 'news.example';
const DOC_1 = 'doc-1';
const DOC_2 = 'doc-2';

const brokenHealth: HealthVector = {
  antiBlockReaction: 0.85,
  contentAvailability: 0.3,
  interaction: 0.1,
  scrollability: 0.1,
  navigationHealth: 0.5,
  visualObstruction: 0.9,
  mutationStability: 0.4,
  confidence: 0.8,
};

const improvedHealth: HealthVector = {
  antiBlockReaction: 0.1,
  contentAvailability: 0.9,
  interaction: 1,
  scrollability: 1,
  navigationHealth: 1,
  visualObstruction: 0.05,
  mutationStability: 0.9,
  confidence: 0.8,
};

class MemoryStorage implements StorageBackend {
  private readonly store = new Map<string, unknown>();

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (this.store.has(k)) out[k] = this.store.get(k);
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      this.store.set(k, v);
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }
}

class MemoryDnrBackend implements DnrBackend {
  session: chrome.declarativeNetRequest.Rule[] = [];
  dynamic: chrome.declarativeNetRequest.Rule[] = [];
  sessionUpdateCalls = 0;
  dynamicUpdateCalls = 0;
  failNextAdd = false;
  failNextRemove = false;

  getDynamicRules = async (): Promise<chrome.declarativeNetRequest.Rule[]> => [...this.dynamic];
  getSessionRules = async (): Promise<chrome.declarativeNetRequest.Rule[]> => [...this.session];

  updateDynamicRules = async (options: {
    addRules?: chrome.declarativeNetRequest.Rule[];
    removeRuleIds?: number[];
  }): Promise<void> => {
    this.dynamicUpdateCalls += 1;
    if (options.addRules && options.addRules.length > 0) {
      this.dynamic.push(...options.addRules);
    }
    if (options.removeRuleIds && options.removeRuleIds.length > 0) {
      const ids = new Set(options.removeRuleIds);
      this.dynamic = this.dynamic.filter((r) => !ids.has(r.id));
    }
  };

  updateSessionRules = async (options: {
    addRules?: chrome.declarativeNetRequest.Rule[];
    removeRuleIds?: number[];
  }): Promise<void> => {
    this.sessionUpdateCalls += 1;
    if (options.addRules && options.addRules.length > 0) {
      if (this.failNextAdd) {
        this.failNextAdd = false;
        throw new Error('injected DNR add failure');
      }
      this.session.push(...options.addRules);
    }
    if (options.removeRuleIds && options.removeRuleIds.length > 0) {
      if (this.failNextRemove) {
        this.failNextRemove = false;
        throw new Error('injected DNR remove failure');
      }
      const ids = new Set(options.removeRuleIds);
      this.session = this.session.filter((r) => !ids.has(r.id));
    }
  };
}

interface Harness {
  storage: MemoryStorage;
  dnr: MemoryDnrBackend;
  controller: DnrController;
  recipes: RecipeStore;
  registry: NavigationRegistry;
  graphStore: EventGraphStore;
  engine: CausalEngine;
  messages: unknown[];
}

function createHarness(opts?: {
  storage?: MemoryStorage;
  dnr?: MemoryDnrBackend;
  sendTabMessage?: (tabId: number, msg: unknown) => Promise<void>;
}): Harness {
  const storage = opts?.storage ?? new MemoryStorage();
  const dnr = opts?.dnr ?? new MemoryDnrBackend();
  const controller = new DnrController(dnr);
  const recipes = new RecipeStore(storage);
  const audit = new AuditStore(storage);
  const messages: unknown[] = [];
  const sendTabMessage =
    opts?.sendTabMessage ??
    (async (_tabId: number, msg: unknown) => {
      messages.push(msg);
    });
  const txEngine = new AdaptationTransactionEngine(controller, recipes, audit, storage, sendTabMessage);
  const registry = new NavigationRegistry();
  const graphStore = new EventGraphStore();
  const engine = new CausalEngine({
    txEngine,
    dnrController: controller,
    dnrBackend: dnr,
    storageBackend: storage,
    registry,
    graphStore,
    sendTabMessage,
    strategyResolution: {
      resolveRequest: () => ({
        urlFilter: '|https://news.example/probe/*',
        resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType],
        firstParty: true,
        trackerLike: false,
      }),
    },
  });
  return { storage, dnr, controller, recipes, registry, graphStore, engine, messages };
}

function commitDoc(registry: NavigationRegistry, documentId: string, tabId = 1) {
  return registry.onNavigationCommitted(tabId, 0, `${ORIGIN}/page`, undefined, documentId);
}

function nowFrom(registry: NavigationRegistry, tabId = 1): CurrentEpochState {
  const key = registry.getCausalKey(tabId, 0);
  if (!key) throw new Error('no live epoch');
  return {
    tabId: key.tabId,
    navigationEpoch: key.navigationEpoch,
    documentId: key.documentId,
    frameId: key.frameId,
  };
}

function makeCandidate(
  variable: ExperimentCandidate['intervention']['variable'],
  scope: ExperimentCandidate['scope'],
  strategyRef: (typeof STRATEGY_REF_ALLOWLIST)[keyof typeof STRATEGY_REF_ALLOWLIST],
  id: ExperimentCandidate['id'] = 'experiment:x1'
): ExperimentCandidate {
  return {
    id,
    hypothesisRef: 'hypothesis:h1',
    intervention: {
      variable,
      actionRefs:
        variable === 'temp_network_exception'
          ? [strategyRef, 'request:r1']
          : [strategyRef, 'element:e1'],
      desiredValue: true,
    },
    scope: {
      tabId: scope.tabId,
      navigationEpoch: scope.navigationEpoch,
      documentId: scope.documentId,
      frameIds: [...scope.frameIds],
    },
    expected: {
      informationGain: 0.7,
      healthRisk: variable === 'temp_network_exception' ? 0.15 : 0.1,
      privacyRisk: 0.08,
      rollbackConfidence: 0.995,
      durationMs: 1500,
    },
    controls: { oneVariable: true, requiresReload: false, pairedBaselineAvailable: true },
    rollbackPlanRef: `rollback:${variable}`,
  };
}

describe('experimentToStrategy', () => {
  it('maps a trusted first-party request ref to a meaningful session exception', () => {
    const h = createHarness();
    const epoch = commitDoc(h.registry, DOC_1);
    const selected = makeCandidate(
      'temp_network_exception',
      {
        tabId: 1,
        navigationEpoch: epoch.navigationEpoch,
        documentId: epoch.documentId,
        frameIds: [0],
      },
      STRATEGY_REF_ALLOWLIST.NETWORK
    );
    const mapped = experimentToStrategy(selected, {
      resolveRequest: () => ({
        urlFilter: '|https://news.example/probe/*',
        resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType],
        firstParty: true,
        trackerLike: false,
      }),
    });
    expect(mapped).not.toBeNull();
    expect(mapped!.isReversible).toBe(true);
    expect(mapped!.estimatedRisk === 'LOW' || mapped!.estimatedRisk === 'MEDIUM').toBe(true);
    expect(mapped!.actions).toHaveLength(1);
    const action = mapped!.actions[0];
    expect(action?.type).toBe('NET_ALLOW_EXCEPTION');
    if (action && action.type === 'NET_ALLOW_EXCEPTION') {
      expect(action.urlFilter).toBe('|https://news.example/probe/*');
    }
  });

  it('abstains when an opaque network ref cannot be safely resolved', () => {
    const selected = makeCandidate(
      'temp_network_exception',
      { tabId: 1, navigationEpoch: 1, documentId: DOC_1, frameIds: [0] },
      STRATEGY_REF_ALLOWLIST.NETWORK
    );
    expect(experimentToStrategy(selected)).toBeNull();
  });

  it('refuses form submit / purchase / auth variables (INV-X5)', () => {
    const epoch = { tabId: 1, navigationEpoch: 1, documentId: DOC_1, frameIds: [0] };
    const selected = makeCandidate('form_submit', epoch, STRATEGY_REF_ALLOWLIST.NETWORK);
    expect(experimentToStrategy(selected)).toBeNull();
  });
});

describe('CausalEngine (M4)', () => {
  it('epoch mismatch aborts with STALE and zero DNR/DOM side effects (INV-X2)', async () => {
    const h = createHarness();
    const epoch = commitDoc(h.registry, DOC_1);
    const selected = makeCandidate(
      'temp_network_exception',
      {
        tabId: 1,
        navigationEpoch: epoch.navigationEpoch + 1,
        documentId: 'stale-doc',
        frameIds: [0],
      },
      STRATEGY_REF_ALLOWLIST.NETWORK
    );
    const result = await h.engine.runCausalExperiment(selected, {
      now: {
        tabId: 1,
        navigationEpoch: epoch.navigationEpoch,
        documentId: epoch.documentId,
        frameId: 0,
      },
      siteKey: SITE_KEY,
      navigationId: epoch.navigationId,
      baselineHealth: brokenHealth,
    });
    expect(result.record.status === 'STALE' || result.record.status === 'ABORTED').toBe(true);
    expect(result.record.status).toBe('STALE');
    expect(h.dnr.sessionUpdateCalls).toBe(0);
    expect(h.dnr.dynamicUpdateCalls).toBe(0);
    expect(h.messages).toHaveLength(0);
    expect(h.dnr.session).toHaveLength(0);
    expect(h.dnr.dynamic).toHaveLength(0);
  });

  it('navigation mid-staged rolls back session rules and discards graph (INV-X2/X8)', async () => {
    const h = createHarness();
    const epoch = commitDoc(h.registry, DOC_1);
    const key = h.registry.getCausalKey(1, 0);
    if (!key) throw new Error('missing key');
    h.graphStore.getOrCreate(key, ORIGIN_HASH);
    expect(h.graphStore.get(key)).toBeDefined();

    const selected = makeCandidate(
      'temp_network_exception',
      {
        tabId: 1,
        navigationEpoch: epoch.navigationEpoch,
        documentId: epoch.documentId,
        frameIds: [0],
      },
      STRATEGY_REF_ALLOWLIST.NETWORK
    );
    const staged = await h.engine.runCausalExperiment(selected, {
      now: nowFrom(h.registry),
      siteKey: SITE_KEY,
      navigationId: epoch.navigationId,
      baselineHealth: brokenHealth,
    });
    expect(staged.record.status).toBe('STAGED');
    expect(h.dnr.session.length).toBeGreaterThan(0);

    const previous = key;
    commitDoc(h.registry, DOC_2);
    await h.engine.onNavigation(1, previous);

    expect(h.dnr.session).toHaveLength(0);
    expect(h.engine.getRecord(selected.id)?.record.status).toBe('ROLLED_BACK');
    expect(h.graphStore.get(previous)).toBeUndefined();
  });

  it('worker death: init from same storage rollbacks STAGED with no commit proof and 0 leaked session rules (INV-X8)', async () => {
    const storage = new MemoryStorage();
    const dnr = new MemoryDnrBackend();
    const h1 = createHarness({ storage, dnr });
    const epoch = commitDoc(h1.registry, DOC_1);
    const selected = makeCandidate(
      'temp_network_exception',
      {
        tabId: 1,
        navigationEpoch: epoch.navigationEpoch,
        documentId: epoch.documentId,
        frameIds: [0],
      },
      STRATEGY_REF_ALLOWLIST.NETWORK
    );
    const staged = await h1.engine.runCausalExperiment(selected, {
      now: nowFrom(h1.registry),
      siteKey: SITE_KEY,
      navigationId: epoch.navigationId,
      baselineHealth: brokenHealth,
    });
    expect(staged.record.status).toBe('STAGED');
    expect(dnr.session.length).toBeGreaterThan(0);
    expect(staged.state?.commitProof).toBe(false);

    // Simulated worker death: new controller + engine, same session-rule backend + storage.
    const h2 = createHarness({ storage, dnr });
    await h2.engine.init();

    expect(dnr.session).toHaveLength(0);
    const recovered = h2.engine.getRecord(selected.id);
    expect(recovered?.record.status).toBe('ROLLED_BACK');
    expect(recovered?.commitProof).toBe(false);
  });

  it('forced DNR add failure after allocation reclaims IDs and leaves no session rules', async () => {
    const h = createHarness();
    h.dnr.failNextAdd = true;
    const epoch = commitDoc(h.registry, DOC_1);
    const selected = makeCandidate(
      'temp_network_exception',
      {
        tabId: 1,
        navigationEpoch: epoch.navigationEpoch,
        documentId: epoch.documentId,
        frameIds: [0],
      },
      STRATEGY_REF_ALLOWLIST.NETWORK
    );
    const result = await h.engine.runCausalExperiment(selected, {
      now: nowFrom(h.registry),
      siteKey: SITE_KEY,
      navigationId: epoch.navigationId,
      baselineHealth: brokenHealth,
    });
    expect(result.record.status).toBe('ABORTED');
    expect(h.dnr.session).toHaveLength(0);
    expect(h.controller.getAllAllocations()).toHaveLength(0);
  });

  it('failure during rollback of one action still runs remaining rollback', async () => {
    const rolled: string[] = [];
    const sendTabMessage = async (_tabId: number, msg: unknown): Promise<void> => {
      const m = msg as { type?: string; actionId?: string };
      if (m.type === 'ROLLBACK_DOM_ACTION') {
        rolled.push(m.actionId ?? '');
        if (rolled.length === 1) throw new Error('injected first DOM rollback failure');
      }
    };
    const h = createHarness({ sendTabMessage });
    const epoch = commitDoc(h.registry, DOC_1);
    const selected = makeCandidate(
      'remove_overlay_gate',
      {
        tabId: 1,
        navigationEpoch: epoch.navigationEpoch,
        documentId: epoch.documentId,
        frameIds: [0],
      },
      STRATEGY_REF_ALLOWLIST.DOM_OVERLAY
    );
    const staged = await h.engine.runCausalExperiment(selected, {
      now: nowFrom(h.registry),
      siteKey: SITE_KEY,
      navigationId: epoch.navigationId,
      baselineHealth: brokenHealth,
    });
    expect(staged.record.status).toBe('STAGED');
    expect(staged.state?.domActionIds.length).toBeGreaterThanOrEqual(2);

    await h.engine.onNavigation(1, h.registry.getCausalKey(1, 0));
    expect(rolled.length).toBeGreaterThanOrEqual(2);
    expect(h.engine.getRecord(selected.id)?.record.status).toBe('ROLLED_BACK');

    // Direct proof of Phase 1 handler used by CausalEngine.
    const handler = new AdaptationRollbackHandler(h.controller, sendTabMessage);
    rolled.length = 0;
    const tx: AdaptationTransaction = {
      txId: 'tx_inject',
      tabId: 1,
      navigationId: epoch.navigationId,
      siteKey: SITE_KEY,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      baselineHealth: brokenHealth,
      candidate: staged.state?.candidate as StrategyCandidate,
      sessionRuleIds: [],
      domActionIds: ['dom_a', 'dom_b'],
      state: 'staged',
    };
    const result = await handler.rollback(tx);
    expect(rolled).toEqual(['dom_a', 'dom_b']);
    expect(result.domActionsRolledBack).toBe(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('successful stage+verify-improved is COMMITTED and does not write a SiteRecipe (INV-X10)', async () => {
    const h = createHarness();
    const epoch = commitDoc(h.registry, DOC_1);
    const selected = makeCandidate(
      'remove_overlay_gate',
      {
        tabId: 1,
        navigationEpoch: epoch.navigationEpoch,
        documentId: epoch.documentId,
        frameIds: [0],
      },
      STRATEGY_REF_ALLOWLIST.DOM_OVERLAY
    );
    const result = await h.engine.runCausalExperiment(selected, {
      now: nowFrom(h.registry),
      siteKey: SITE_KEY,
      navigationId: epoch.navigationId,
      baselineHealth: brokenHealth,
      postHealth: improvedHealth,
    });
    expect(result.record.status).toBe('COMMITTED');
    expect(result.state?.commitProof).toBe(true);
    const recipes = await h.recipes.getAllRecipes();
    expect(recipes).toHaveLength(0);
  });

  it('second overlapping experiment on the same tab while first is staged is rejected (INV-X4)', async () => {
    const h = createHarness();
    const epoch = commitDoc(h.registry, DOC_1);
    const scope = {
      tabId: 1,
      navigationEpoch: epoch.navigationEpoch,
      documentId: epoch.documentId,
      frameIds: [0],
    };
    const first = makeCandidate('restore_scroll', scope, STRATEGY_REF_ALLOWLIST.RESTORE_SCROLL, 'experiment:x1');
    const second = makeCandidate('preserve_bait_geometry', scope, STRATEGY_REF_ALLOWLIST.PRESERVE_BAIT, 'experiment:x2');
    const runCtx: CausalRunContext = {
      now: nowFrom(h.registry),
      siteKey: SITE_KEY,
      navigationId: epoch.navigationId,
      baselineHealth: brokenHealth,
    };
    const a = await h.engine.runCausalExperiment(first, runCtx);
    expect(a.record.status).toBe('STAGED');
    const sessionCallsAfterFirst = h.dnr.sessionUpdateCalls;
    const messageCountAfterFirst = h.messages.length;

    const b = await h.engine.runCausalExperiment(second, runCtx);
    expect(b.record.status).toBe('ABORTED');
    expect(h.engine.getRecord(first.id)?.record.status).toBe('STAGED');
    expect(h.dnr.sessionUpdateCalls).toBe(sessionCallsAfterFirst);
    expect(h.messages.length).toBe(messageCountAfterFirst);
  });
});
