import { NavigationRegistry } from '../core/navigation/registry';
import { RequestGraphManager } from '../core/network/request-graph';
import { RequestObserver } from '../core/network/observer';
import { DnrController } from '../core/dnr/controller';
import { RecipeStore } from '../core/recipes/store';
import { AuditStore } from '../core/audit/store';
import { AdaptationTransactionEngine } from '../core/adaptation/engine';
import { extractSiteKey, isSyntheticDocumentId } from '../core/navigation/epoch';
import { ContentToBackgroundMessage } from '../shared/messages';
import { ChromeStorageBackend } from '../background/storage/chrome-storage';
import { EpochRouter } from '../background/causal/epoch-router';
import { EventGraphStore } from '../background/causal/graph-store';
import { BeliefUpdater } from '../background/causal/belief-updater';
import { CausalSessionStateRepository } from '../background/causal/session-state';
import { CausalEngine } from '../background/causal/causal-engine';
import { CausalOrchestrator, CausalResourceRegistry } from '../background/causal/orchestrator';
import { CausalRecipeStore, PromotionGate } from '../background/causal/promotion-gate';
import { isHealthVector, isPageSignalBatch, isUserIntentEnvelope } from '../shared/guards';
import { reconcilePhase31StaticRulesets } from '../background/phase31/static-rulesets';
import { runMainScriptlet } from '../shared/main-scriptlet';
import { IntentTracker } from '../background/autonomy/intent-tracker';
import { classifyNavigationTarget } from '../background/autonomy/popup-classifier';
import { EphemeralNavigationTargetRegistry } from '../background/autonomy/navigation-targets';
import { PrimitiveExecutorRegistry } from '../background/autonomy/executor-registry';
import { AutonomySessionRepository } from '../background/autonomy/session';
import { AI_CONFIG_STORAGE_KEY, assertProductionPlanner, loadConfiguredPlanner, resolveProviderKind, validConfig } from '../background/ai/remote-planner';
import { DEV_DEFAULT_AI_CONFIG } from '../background/ai/dev-defaults';
import { OwnershipStore } from '../core/dnr/ownership';
import { PersonalLearningManager } from '../background/learning/personal-learning';
import { StealthProfileStore } from '../background/learning/stealth-profiles';
import { CosmeticProfileStore } from '../background/learning/cosmetic-profiles';
import { AiNegativeMemoryStore } from '../background/learning/ai-negative-memory';
import { readPlannerStatus } from '../background/ai/status';
import { runPlannerConnectionTest } from '../background/ai/test-connection';
import { NavigationEpoch } from '../shared/types';
import { forensics } from '../background/forensics/runtime-trace';
import { isProtectedFlowHost } from '../shared/protected-flows';
import { ProtectedTransactionManager } from '../background/protected-transactions';
import { PauseManager, sanitizePausedHosts } from '../background/pause-manager';
import { STORAGE_KEYS } from '../shared/constants';

/** hostFromUrl: tolerant hostname extraction for transaction origin tracking. */
function hostFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

// Dev-only forensics (artifacts/kimi-forensics): marks every service-worker evaluation
// so restarts between external test runs are visible in the trace.
forensics.event('SW_START');

const ALLOWED_MAIN_SCRIPTLETS = new Set([
  'set-constant',
  'abort-current-inline-script',
  'abort-on-property-read',
  'abort-on-property-write',
  'prevent-fetch',
  'prevent-xhr',
  'prevent-setTimeout',
  'prevent-setInterval',
  'prevent-eval-if',
  'prevent-window-open',
  'json-prune',
  'adjust-setInterval',
  'adjust-setTimeout',
  'prevent-addEventListener',
  'prevent-element-src-loading',
  'set-cookie',
  'set-local-storage-item',
  'set-session-storage-item',
]);

const requestEpochs = new Map<string, NavigationEpoch>();
const contentEpochs = new Map<string, NavigationEpoch>();

function sameDocumentUrl(existingUrl: string, incomingUrl: string): boolean {
  try {
    const existing = new URL(existingUrl);
    const incoming = new URL(incomingUrl);
    return existing.origin === incoming.origin
      && existing.pathname === incoming.pathname
      && existing.search === incoming.search;
  } catch {
    return false;
  }
}

function contentEpochKey(tabId: number, frameId: number, navigationId: string): string {
  return `${tabId}\u0000${frameId}\u0000${navigationId}`;
}

/**
 * A content message may only replace the registry epoch when the sender is the
 * frame's LIVE document. The recreate branch exists for commits the worker
 * missed while dead — but the same branch is reachable from a DEAD document
 * whose message outlived it (e.g. an about:blank READY queued before the tab
 * navigated, delivered after the commit handler created the new epoch; every
 * content script runs with match_about_blank). Replacing the live epoch for a
 * dead sender strands the live document's batches as stale forever, because
 * contentEpochs keeps resolving its navigationId to the evicted epoch.
 * webNavigation.getFrame is the browser's authoritative live-document check.
 */
async function senderIsLiveDocument(
  tabId: number,
  frameId: number,
  url: string,
  documentId?: string
): Promise<boolean> {
  try {
    const getFrame = chrome.webNavigation?.getFrame;
    if (typeof getFrame !== 'function') return true; // stubbed environments
    const frame = await getFrame({ tabId, frameId });
    if (!frame) return false;
    if (documentId && typeof frame.documentId === 'string' && frame.documentId.length > 0) {
      return frame.documentId === documentId;
    }
    return url.length > 0 && sameDocumentUrl(frame.url, url);
  } catch {
    // Fail closed: a live sender whose check errors out retries (READY chain)
    // or resends on the next mutation; a dead sender must never win.
    if (forensics.enabled) forensics.count('epochLivenessCheckFailed');
    return false;
  }
}

async function captureContentEpoch(
  tabId: number,
  frameId: number,
  navigationId: string,
  url: string,
  documentId?: string
): Promise<NavigationEpoch | undefined> {
  const existingContext = contentEpochs.get(contentEpochKey(tabId, frameId, navigationId));
  if (existingContext) {
    // SPA route changes mint a new navigationEpoch for the SAME document, but
    // the content script keeps signing with the navigationId it was born with —
    // history.pushState fires no page-side event it can observe. If the sender
    // is still the live document (same documentId), re-resolve to the live
    // epoch; otherwise every post-route-change observation is rejected
    // STALE_EPOCH by the graph router and the pipeline goes blind for the rest
    // of the document's life. A superseded document can never cross: its
    // documentId differs from the live one by definition.
    const live = navRegistry.getEpoch(tabId, frameId);
    if (
      live &&
      live.navigationId !== existingContext.navigationId &&
      existingContext.documentId.length > 0 &&
      live.documentId === existingContext.documentId
    ) {
      contentEpochs.set(contentEpochKey(tabId, frameId, navigationId), live);
      return live;
    }
    return existingContext;
  }

  let epoch = navRegistry.getEpoch(tabId, frameId);
  if (!epoch || (url.length > 0 && !sameDocumentUrl(epoch.url, url))) {
    if (epoch && !(await senderIsLiveDocument(tabId, frameId, url, documentId))) {
      if (forensics.enabled) {
        forensics.count('contentEpochDeadDocumentDrops');
        forensics.event('DEAD_DOCUMENT_MESSAGE_DROPPED', { tabId, frameId });
      }
      return undefined;
    }
    epoch = navRegistry.onNavigationCommitted(tabId, frameId, url, undefined, documentId);
    if (forensics.enabled) {
      forensics.event('EPOCH_CREATED_FROM_CONTENT', {
        tabId,
        hasDocumentId: Boolean(documentId),
        navId: epoch.navigationId.slice(-10),
        urlHash: forensics.hash(url),
        docTail: documentId ? documentId.slice(-6) : 'none',
      });
    }
  } else {
    navRegistry.reconcileDocumentId(tabId, frameId, url, documentId);
    if (documentId && !navRegistry.matchesDocumentId(tabId, frameId, documentId)) {
      // Alias only while the live epoch's documentId is still synthetic (the
      // commit handler has not told us the real id yet). When the live epoch
      // already carries a REAL, different documentId, the sender is a new
      // document whose READY raced the commit (reload under load) — aliasing
      // it onto the dead epoch would glue every later batch to the dead
      // document's scope: the router drops its appends and recipe decisions
      // run against the predecessor's graph. Fall through and mint a fresh
      // content-born epoch instead; the commit handler adopts it by
      // documentId when it catches up.
      const live = navRegistry.getEpoch(tabId, frameId);
      if (live && (live.documentId.length === 0 || isSyntheticDocumentId(live.documentId))) {
        navRegistry.aliasDocumentId(tabId, frameId, url, documentId);
      }
    }
  }
  if (documentId && !navRegistry.matchesDocumentId(tabId, frameId, documentId)) {
    epoch = navRegistry.onNavigationCommitted(tabId, frameId, url, undefined, documentId);
  }
  contentEpochs.set(contentEpochKey(tabId, frameId, navigationId), epoch);
  while (contentEpochs.size > 128) contentEpochs.delete(contentEpochs.keys().next().value as string);
  return epoch;
}

// 1. Storage Backend Implementation for chrome.storage.local
const chromeStorageBackend = new ChromeStorageBackend(chrome.storage.local);
const chromeSessionBackend = new ChromeStorageBackend(chrome.storage.session);

// 2. DNR Backend Implementation
const chromeDnrBackend = {
  getDynamicRules: async () => chrome.declarativeNetRequest.getDynamicRules(),
  getSessionRules: async () => chrome.declarativeNetRequest.getSessionRules(),
  updateDynamicRules: async (opts: { addRules?: chrome.declarativeNetRequest.Rule[]; removeRuleIds?: number[] }) =>
    chrome.declarativeNetRequest.updateDynamicRules(opts),
  updateSessionRules: async (opts: { addRules?: chrome.declarativeNetRequest.Rule[]; removeRuleIds?: number[] }) =>
    chrome.declarativeNetRequest.updateSessionRules(opts),
};

// 3. Tab Message Sender
const sendTabMessageResponse = async (tabId: number, msg: unknown) => {
  return new Promise<{ success?: boolean; actionIds?: string[] }>((resolve, reject) => {
    const documentId =
      typeof msg === 'object' && msg !== null && 'documentId' in msg && typeof msg.documentId === 'string'
        ? msg.documentId
        : undefined;
    const callback = (response?: { success?: boolean }) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('Content script did not acknowledge action'));
        return;
      }
      resolve(response);
    };
    if (documentId) chrome.tabs.sendMessage(tabId, msg, { documentId }, callback);
    else chrome.tabs.sendMessage(tabId, msg, callback);
  });
};

const sendTabMessage = async (tabId: number, msg: unknown): Promise<void> => {
  await sendTabMessageResponse(tabId, msg);
};

// 4. Instantiate Core Domain Modules
const navRegistry = new NavigationRegistry();
const graphManager = new RequestGraphManager();
const requestObserver = new RequestObserver(navRegistry, graphManager);
const dnrOwnership = new OwnershipStore(
  {
    get: (key) => chrome.storage.session.get(key),
    set: (items) => chrome.storage.session.set(items),
  },
  {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
  }
);
const dnrController = new DnrController(chromeDnrBackend, dnrOwnership);
const personalLearning = new PersonalLearningManager(dnrController);
const protectedTransactions = new ProtectedTransactionManager(chromeDnrBackend);
const pauseManager = new PauseManager(chromeDnrBackend, chromeStorageBackend);
const stealthProfiles = new StealthProfileStore();
const cosmeticProfiles = new CosmeticProfileStore();
const aiNegativeMemory = new AiNegativeMemoryStore();
/** tabId → css + selectors injected this navigation (Phase E replay guard). */
const cosmeticReplayByTab = new Map<number, { css: string; selectors: string[] }>();
const recipeStore = new RecipeStore(chromeStorageBackend);
const auditStore = new AuditStore(chromeStorageBackend);
const adaptEngine = new AdaptationTransactionEngine(
  dnrController,
  recipeStore,
  auditStore,
  chromeStorageBackend,
  sendTabMessage,
  undefined,
  (tabId, navigationId) => {
    const valid = navRegistry.isEpochValid(tabId, navigationId);
    if (!valid && forensics.enabled) {
      // navigationIds are random per-document tokens (page_<ts>_<rand>) — not URLs.
      forensics.event('ENGINE_DROP_STALE_NAV', {
        tabId,
        incoming: navigationId.slice(-10),
        current: navRegistry.getEpoch(tabId, 0)?.navigationId.slice(-10) ?? 'none',
      });
    }
    return valid;
  }
);
const causalResources = new CausalResourceRegistry();
const navigationTargets = new EphemeralNavigationTargetRegistry(chromeSessionBackend);
const autonomySession = new AutonomySessionRepository(chromeSessionBackend);
const primitiveExecutors = new PrimitiveExecutorRegistry({
  dnrController,
  sendTabMessage: sendTabMessageResponse,
  resolveRequest: (ref) => causalResources.resolveRequest(ref as `request:r${number}`),
  navigationTargets,
  tabsApi: chrome.tabs,
});
const causalGraphs = new EventGraphStore(new EpochRouter(navRegistry));
const beliefUpdater = new BeliefUpdater();
const causalSession = new CausalSessionStateRepository(
  chromeSessionBackend,
  navRegistry,
  causalGraphs,
  beliefUpdater
);
const causalRecipeStore = new CausalRecipeStore(chromeStorageBackend);
const promotionGate = new PromotionGate({ store: causalRecipeStore });
const causalEngine = new CausalEngine({
  txEngine: adaptEngine,
  dnrController,
  dnrBackend: chromeDnrBackend,
  storageBackend: chromeSessionBackend,
  registry: navRegistry,
  graphStore: causalGraphs,
  sendTabMessage,
  strategyResolution: causalResources,
});
const causalOrchestrator = new CausalOrchestrator({
  registry: navRegistry,
  requestGraphs: graphManager,
  graphs: causalGraphs,
  beliefs: beliefUpdater,
  engine: causalEngine,
  session: causalSession,
  sendTabMessage,
  recipeStore: causalRecipeStore,
  promotion: promotionGate,
  primitiveExecutors,
  autonomySession,
  runFallback: (tabId, navigationId, siteKey, batch) =>
    adaptEngine.evaluateSignals(tabId, navigationId, siteKey, batch),
  personalLearning,
  stealthLearning: {
    learnConstantsForSite: (siteKey, constants) => stealthProfiles.learnConstantsForSite(siteKey, constants),
  },
  cosmeticLearning: {
    confirmHides: (txId) => cosmeticProfiles.confirmHides(txId),
    discardHides: (txId) => cosmeticProfiles.discardHides(txId),
    replayFor: (url) => cosmeticProfiles.replayFor(url),
  },
  aiNegativeMemory,
  isProtectedTransactionActive: (tabId) => protectedTransactions.isActive(tabId),
  // A paused host is a user-declared no-fly zone: no autonomy or survivor-AI
  // experiments on its tabs, same stand-down discipline as protected flows.
  isPausedTab: (tabId) => {
    const origin = navRegistry.getEpoch(tabId, 0)?.origin;
    return origin ? pauseManager.isPaused(hostFromUrl(origin) ?? '') : false;
  },
});
const intentTracker = new IntentTracker();
const startupReady = (async () => {
  // Ownership metadata must be loaded before any rule can be added/removed so the
  // allocator never reuses an ID that Chrome or a previous worker already owns.
  await dnrOwnership.load().catch(() => undefined);
  await stealthProfiles.load().catch(() => undefined);
  await cosmeticProfiles.load().catch(() => undefined);
  await aiNegativeMemory.load().catch(() => undefined);
  await causalSession.restore().catch(() => false);
  // Recipe lifecycles must be rehydrated before any replay: an INVALIDATED recipe
  // re-inferred from stableReplays would come back as RECIPE_SAFE after restart.
  await promotionGate.hydrateLifecycles().catch(() => undefined);
  await navigationTargets.restore().catch(() => undefined);
  const autonomySnapshot = await autonomySession.restoreSnapshot().catch(() => undefined);
  await causalOrchestrator.restoreAutonomy(autonomySnapshot);
  // Survivor-AI pendings suspended mid-verification are unverifiable after a
  // restart — settle (roll back) anything the previous worker left staged.
  await causalOrchestrator.restoreSurvivorAiPending().catch(() => undefined);
  await adaptEngine.init();
  adaptEngine.setAiNegativeMemory(aiNegativeMemory);
  await loadConfiguredPlanner(chromeStorageBackend, DEV_DEFAULT_AI_CONFIG).then((loaded) => {
    assertProductionPlanner(loaded?.planner);
    adaptEngine.setAdaptivePlanner(loaded?.planner);
    causalOrchestrator.setAdaptivePlanner(loaded?.planner);
    causalOrchestrator.setAiPrivacyMode(loaded?.privacyMode ?? 'STRICT');
    if (forensics.enabled) {
      forensics.event('AI_CONFIG', {
        configured: loaded !== undefined,
        source: loaded?.source ?? 'none',
        plannerClass: (loaded?.planner as { plannerKind?: string } | undefined)?.plannerKind ?? 'none',
        endpointClass: (loaded?.planner as { endpointClass?: string } | undefined)?.endpointClass ?? 'none',
      });
    }
  }).catch(() => undefined);
  await causalEngine.init();
  if (forensics.enabled) {
    forensics.event('STARTUP_READY', {
      autonomySnapshot: autonomySnapshot !== undefined,
      activeTransactions: adaptEngine.getActiveTransactions().length,
      ruleAllocationsRestored: dnrController.getAllAllocations().length,
    });
    void forensics.snapshotSessionRules('startup-ready');
  }
  void reconcilePhase31StaticRulesets();
})();
const causalQueues = new Map<number, Promise<boolean>>();
const causalHandledBatches = new Map<number, Map<number, boolean>>();
/** READY/hashchange flood bound: a hostile page flipping location.hash in a
 * loop re-sends PAGE_SENSOR_READY per flip. Recipe replay work (storage read +
 * tab messages) is throttled per document; genuine new documents always get
 * exactly one replay. */
const readyReplayThrottle = new Map<string, number>();
const READY_REPLAY_MIN_INTERVAL_MS = 1_000;
const READY_REPLAY_THROTTLE_MAX_KEYS = 512;

// Per-site pause: the popup writes the list; this manager is the single writer of
// the DNR allowance. Membership flips reload the affected tabs so every plane
// (including the pre-paint cosmetic plane, which applies at document_start)
// restarts into the new state.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const change = changes[STORAGE_KEYS.PAUSED_HOSTS];
  if (!change) return;
  const before = sanitizePausedHosts(change.oldValue);
  const after = sanitizePausedHosts(change.newValue);
  void startupReady.then(async () => {
    await pauseManager.sync(after).catch(() => undefined);
    const flipped = [...before.filter((host) => !after.includes(host)), ...after.filter((host) => !before.includes(host))];
    if (flipped.length === 0) return;
    const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
    for (const tab of tabs) {
      if (tab.id === undefined || !tab.url) continue;
      const host = hostFromUrl(tab.url);
      if (host && flipped.some((paused) => host === paused || host.endsWith(`.${paused}`))) {
        void chrome.tabs.reload(tab.id).catch(() => undefined);
      }
    }
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.adapt_ai_config) return;
  void startupReady.then(() => loadConfiguredPlanner(chromeStorageBackend, DEV_DEFAULT_AI_CONFIG)).then((loaded) => {
    assertProductionPlanner(loaded?.planner);
    adaptEngine.setAdaptivePlanner(loaded?.planner);
    causalOrchestrator.setAdaptivePlanner(loaded?.planner);
    causalOrchestrator.setAiPrivacyMode(loaded?.privacyMode ?? 'STRICT');
    if (forensics.enabled) {
      forensics.event('AI_CONFIG_CHANGED', {
        configured: loaded !== undefined,
        source: loaded?.source ?? 'none',
        plannerClass: (loaded?.planner as { plannerKind?: string } | undefined)?.plannerKind ?? 'none',
        endpointClass: (loaded?.planner as { endpointClass?: string } | undefined)?.endpointClass ?? 'none',
      });
    }
  }).catch(() => undefined);
});

// Extension-page administration channel (Options page). Only trusted extension
// contexts may query AI status or run the bounded connection test: sender.id pins the
// sender to this extension, and the extension-origin URL check excludes content
// scripts (whose sender.url is the hosting http(s) page) and any foreign sender.
// The connection test touches no page, installs no rules, and creates no learned state.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  const scoped = message as { scope?: string; type?: string; config?: unknown };
  if (scoped.scope !== 'adapt-ai-admin') return false;
  if (sender.id !== chrome.runtime.id) return false;
  const extensionOrigin = chrome.runtime.getURL('');
  if (typeof sender.url !== 'string' || !sender.url.startsWith(extensionOrigin)) return false;

  if (scoped.type === 'AI_GET_STATUS') {
    void (async () => {
      const stored = await chrome.storage.local.get([AI_CONFIG_STORAGE_KEY]);
      const status = await readPlannerStatus();
      const hasStored = AI_CONFIG_STORAGE_KEY in stored;
      const config = hasStored ? stored[AI_CONFIG_STORAGE_KEY] : DEV_DEFAULT_AI_CONFIG;
      sendResponse({
        configured: validConfig(config),
        source: !validConfig(config) ? 'none' : hasStored ? 'stored' : 'built-in-default',
        endpoint: validConfig(config) ? config.endpoint : null,
        hasToken: validConfig(config) && typeof config.token === 'string' && config.token.length > 0,
        privacyMode: validConfig(config) ? config.privacyMode ?? 'STRICT' : 'STRICT',
        provider: validConfig(config) ? resolveProviderKind(config) : null,
        model: validConfig(config) ? config.model ?? null : null,
        timeoutMs: validConfig(config) ? config.timeoutMs ?? null : null,
        status,
      });
    })().catch(() => sendResponse({ configured: false, source: 'none', endpoint: null, hasToken: false, privacyMode: 'STRICT', provider: null, model: null, timeoutMs: null, status: { version: 1 } }));
    return true;
  }

  // Tests the baked-in default config — used by the Options page when nothing is stored.
  if (scoped.type === 'AI_TEST_DEFAULT_CONNECTION') {
    void (async () => {
      if (!validConfig(DEV_DEFAULT_AI_CONFIG)) {
        sendResponse({ providerReached: false, schemaValid: false, latencyMs: null, errorClass: 'invalid-config' });
        return;
      }
      const result = await runPlannerConnectionTest(DEV_DEFAULT_AI_CONFIG);
      sendResponse(result);
    })().catch(() => sendResponse({ providerReached: false, schemaValid: false, latencyMs: null, errorClass: 'transport' }));
    return true;
  }

  if (scoped.type === 'AI_TEST_CONNECTION') {
    void (async () => {
      if (!validConfig(scoped.config)) {
        sendResponse({ providerReached: false, schemaValid: false, latencyMs: null, errorClass: 'invalid-config' });
        return;
      }
      const result = await runPlannerConnectionTest(scoped.config);
      sendResponse(result);
    })().catch(() => sendResponse({ providerReached: false, schemaValid: false, latencyMs: null, errorClass: 'transport' }));
    return true;
  }

  return false;
});

// Personal-learning administration channel (Options page): count + full reset of
// durable adaptive memory. Same sender pinning as the AI admin channel; never
// returns raw hosts — counts only.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  const scoped = message as { scope?: string; type?: string };
  if (scoped.scope !== 'adapt-learning-admin') return false;
  if (sender.id !== chrome.runtime.id) return false;
  const extensionOrigin = chrome.runtime.getURL('');
  if (typeof sender.url !== 'string' || !sender.url.startsWith(extensionOrigin)) return false;

  if (scoped.type === 'LEARNING_STATUS') {
    void startupReady.then(() => {
      sendResponse({ personalRuleCount: personalLearning.personalRuleCount() });
    }).catch(() => sendResponse({ personalRuleCount: 0 }));
    return true;
  }

  if (scoped.type === 'LEARNING_CLEAR_ALL') {
    void startupReady.then(async () => {
      const removed = await personalLearning.clearAll();
      sendResponse({ cleared: true, removed });
    }).catch(() => sendResponse({ cleared: false, removed: 0 }));
    return true;
  }

  return false;
});

// 5. Synchronous Top-Level Service Worker Listeners

/**
 * Events queued while the worker was dead are delivered at wake in send order —
 * a SUPERSEDED commit (the tab has already navigated past it) can arrive after
 * the live document's own messages created an epoch. Applying it would evict
 * the live epoch (main-frame commits clear the frame map) and strand the live
 * document's contentEpochs entry on the evicted object: every later batch is
 * then dropped as stale. The browser's own frame state is the authority on
 * which document is live; a commit that no longer matches it is dropped whole
 * (registry, intent, and causal side effects all belong to a dead document).
 */
async function commitReflectsLiveDocument(
  tabId: number,
  frameId: number,
  url: string,
  documentId?: string
): Promise<boolean> {
  try {
    const getFrame = chrome.webNavigation?.getFrame;
    if (typeof getFrame !== 'function') return true; // stubbed environments
    const frame = await getFrame({ tabId, frameId });
    if (!frame) return false;
    if (documentId && typeof frame.documentId === 'string' && frame.documentId.length > 0) {
      return frame.documentId === documentId;
    }
    return sameDocumentUrl(frame.url, url);
  } catch {
    if (forensics.enabled) forensics.count('commitLivenessCheckFailed');
    return false;
  }
}

// WebNavigation Lifecycle
// Protected Transaction Mode (Layer 2): a main-frame navigation STARTING toward
// a protected-flow host enters the tab into conservative mode BEFORE the flow's
// first byte — popup OAuth tabs and full-page redirect chains both arrive here.
// The pre-navigation epoch origin is the flow's origin for return detection.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  void startupReady.then(async () => {
    const origin = navRegistry.getEpoch(details.tabId, 0)?.origin;
    const originHost = origin ? hostFromUrl(origin) : undefined;
    await protectedTransactions.onBeforeNavigate(details.tabId, details.frameId, details.url, originHost);
    // Opportunistic TTL reap — no alarms permission; any navigation event in
    // any tab bounds staleness, and idle tabs make no requests to expose.
    await protectedTransactions.sweep();
  });
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  await startupReady;
  if (forensics.enabled) {
    forensics.event('NAV_COMMIT_SEEN', {
      tabId: details.tabId,
      frameId: details.frameId,
      urlHash: forensics.hash(details.url),
      docTail: typeof details.documentId === 'string' ? details.documentId.slice(-6) : 'none',
    });
  }
  if (!(await commitReflectsLiveDocument(details.tabId, details.frameId, details.url, details.documentId))) {
    if (forensics.enabled) {
      forensics.count('staleCommitEventsDropped');
      forensics.event('STALE_COMMIT_DROPPED', {
        tabId: details.tabId,
        frameId: details.frameId,
        urlHash: forensics.hash(details.url),
      });
    }
    return;
  }
  // Transaction lifecycle: frame activity keeps the flow alive; a main-frame
  // return to the originating origin ends it. Stale commits never reach here.
  await protectedTransactions.onCommitted(details.tabId, details.frameId, details.url);
  navRegistry.reconcileDocumentId(
    details.tabId,
    details.frameId,
    details.url,
    details.documentId
  );
  const committedSourceOrigin = navRegistry.getEpoch(details.tabId, details.frameId)?.origin;
  intentTracker.observeNavigationCommitted(details.tabId, details.frameId, details.url, details.timeStamp, committedSourceOrigin);
  const previous = navRegistry.getCausalKey(details.tabId, details.frameId);
  if (!previous || !navRegistry.matchesDocumentId(details.tabId, details.frameId, details.documentId)) {
    await causalEngine.onNavigation(details.tabId, previous, {
      preservePreviousGraph: causalOrchestrator.hasPendingNavigationClosure(details.tabId)
        || details.frameId === 0
        || intentTracker.hasRecentIntent(details.tabId, details.frameId, details.timeStamp),
    });
  }
  const parentFrameId = 'parentFrameId' in details ? (details as { parentFrameId: number }).parentFrameId : undefined;
  const priorEpoch = navRegistry.getEpoch(details.tabId, details.frameId);
  const epoch = navRegistry.onNavigationCommitted(
    details.tabId,
    details.frameId,
    details.url,
    parentFrameId,
    details.documentId
  );
  if (forensics.enabled && priorEpoch && priorEpoch !== epoch) {
    forensics.event('NAV_COMMIT_REPLACED_EPOCH', {
      tabId: details.tabId,
      priorNavId: priorEpoch.navigationId.slice(-10),
      newNavId: epoch.navigationId.slice(-10),
      priorDocumentSynthetic: priorEpoch.documentId.startsWith('missing:'),
      urlMatch: sameDocumentUrl(priorEpoch.url, details.url),
      priorUrlHash: forensics.hash(priorEpoch.url),
      newUrlHash: forensics.hash(details.url),
      priorDocTail: priorEpoch.documentId.slice(-6),
      newDocTail: typeof details.documentId === 'string' ? details.documentId.slice(-6) : 'none',
    });
  }
  await causalOrchestrator.onNavigation({
    type: 'committed',
    tabId: details.tabId,
    frameId: details.frameId,
    url: details.url,
    parentFrameId,
    documentId: details.documentId,
    timeStamp: details.timeStamp,
  });

  // If top-level navigation committed, rollback any pending orphaned experiments on this tab
  if (epoch.isMainFrame) {
    // Per-site pause: learned replay planes stand down on paused hosts.
    const pausedNav = pauseManager.isPaused(hostFromUrl(details.url) ?? '');
    // Stealth plane (D2a): new navigation resets the tab's bait-learning context;
    // replay learned detector-bait markers in the MAIN world before page scripts run.
    stealthProfiles.resetTab(details.tabId, details.documentId);
    if (forensics.enabled) forensics.event('STEALTH_TAB_RESET', { tab: details.tabId, urlHash: forensics.hash(details.url) });
    // Cold-worker correctness: profiles live behind an async storage load. Gate
    // the proactive replay on it or restart navigations silently replay nothing.
    if (!pausedNav) void stealthProfiles.load().then(() => {
      const stealthReplay = stealthProfiles.replayFor(details.url);
      if (stealthReplay.baitIds.length > 0 || stealthReplay.constants.length > 0) {
      void chrome.scripting.executeScript({
        target: { tabId: details.tabId, frameIds: [0] },
        world: 'MAIN',
        func: (ids: string[], constants: Array<{ path: string; value: string }>) => {
          for (const id of ids) {
            try {
              if (!/^[A-Za-z0-9]{10,40}$/.test(id) || document.getElementById(id)) continue;
              const div = document.createElement('div');
              div.id = id;
              div.style.display = 'none';
              div.setAttribute('aria-hidden', 'true');
              (document.documentElement || document).appendChild(div);
            } catch {
              /* never throw into the page */
            }
          }
          // AI-learned detector counter-constants (D2b): set-constant semantics —
          // getter returns the benign value, writes are swallowed. Grammar was
          // validated before persistence; re-checked here as defense in depth.
          const VALUES: Record<string, unknown> = {
            undefined, null: null, true: true, false: false,
            noopFunc: () => undefined,
            noopCallbackFunc: () => undefined,
            noopPromiseResolve: () => Promise.resolve(undefined),
            noopPromiseReject: () => Promise.reject(new Error()),
            trueFunc: () => true,
            falseFunc: () => false,
            emptyObj: Object.freeze(Object.create(null)),
            emptyArray: Object.freeze([]),
            emptyArr: Object.freeze([]),
          };
          for (const { path, value } of constants) {
            try {
              const segments = path.split('.');
              if (segments.length > 8 || segments.some((s) => !/^[A-Za-z_$][\w$]{0,63}$/.test(s)
                || s === '__proto__' || s === 'prototype' || s === 'constructor')) continue;
              const resolved = Object.prototype.hasOwnProperty.call(VALUES, value)
                ? VALUES[value]
                : /^-?\d{1,6}(?:\.\d{1,3})?$/.test(value) ? Number(value) : undefined;
              if (resolved === undefined && value !== 'undefined') continue;
              let parent = globalThis as unknown as Record<string, unknown>;
              for (const segment of segments.slice(0, -1)) {
                const next = parent[segment];
                if (next && typeof next === 'object') {
                  parent = next as Record<string, unknown>;
                  continue;
                }
                const created: Record<string, unknown> = Object.create(null);
                Object.defineProperty(parent, segment, { configurable: true, enumerable: false, writable: true, value: created });
                parent = created;
              }
              const key = segments[segments.length - 1]!;
              Object.defineProperty(parent, key, {
                configurable: true, enumerable: false, get: () => resolved, set: () => undefined,
              });
            } catch {
              /* never throw into the page */
            }
          }
        },
        args: [stealthReplay.baitIds, stealthReplay.constants],
        injectImmediately: true,
      }).catch(() => undefined);
      }
    });

    // Cosmetic learning plane (Phase E): replay learned per-site hides as
    // pre-paint CSS at commit. Narrow load gate — same cold-worker reason as
    // the stealth replay above. Also stands down on paused hosts.
    if (!pausedNav) void cosmeticProfiles.load().then(() => {
      const cosmeticSelectors = cosmeticProfiles.replayFor(details.url);
      if (cosmeticSelectors.length === 0) return;
      const css = cosmeticSelectors.map((selector) => `${selector} { display: none !important; }`).join('\n');
      cosmeticReplayByTab.set(details.tabId, { css, selectors: cosmeticSelectors });
      if (cosmeticReplayByTab.size > 500) {
        const oldest = cosmeticReplayByTab.keys().next().value;
        if (oldest !== undefined) cosmeticReplayByTab.delete(oldest);
      }
      void chrome.scripting.insertCSS({
        target: { tabId: details.tabId, frameIds: [0] },
        css,
      }).catch(() => {
        cosmeticReplayByTab.delete(details.tabId);
      });
    });
    const activeTxs = adaptEngine.getActiveTransactions().filter(
      (tx) => tx.tabId === details.tabId && tx.navigationId !== epoch.navigationId
    );
    for (const tx of activeTxs) {
      if (tx.state === 'staged' || tx.state === 'observing') {
        await adaptEngine.rollbackAllOrphaned();
      }
    }
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  // SPA: documentId is already on the live epoch and must not be overwritten.
  // Chrome's documentId is stable across history.pushState (M0 F1).
  void startupReady.then(async () => {
    // Same wake-ordering hazard as commits: a queued history event from a
    // superseded document must not rewrite the live document's epoch.
    if (!(await commitReflectsLiveDocument(details.tabId, details.frameId, details.url, details.documentId))) {
      if (forensics.enabled) forensics.count('staleHistoryEventsDropped');
      return;
    }
    const previous = navRegistry.getCausalKey(details.tabId, details.frameId);
    await causalEngine.onNavigation(details.tabId, previous);
    navRegistry.onHistoryStateUpdated(details.tabId, details.frameId, details.url);
    await causalOrchestrator.onNavigation({
      type: 'history',
      tabId: details.tabId,
      frameId: details.frameId,
      url: details.url,
      documentId: details.documentId,
      timeStamp: details.timeStamp,
    });
  });
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void startupReady.then(async () => {
    // Popup-tab adoption: a window.open toward a protected-flow host enters the
    // NEW tab into conservative mode at birth — its first requests run before
    // the onBeforeNavigate trigger could install the allowance otherwise.
    const targetHost = hostFromUrl(details.url);
    if (targetHost && isProtectedFlowHost(targetHost)) {
      const sourceOrigin = navRegistry.getEpoch(details.sourceTabId, details.sourceFrameId)?.origin;
      await protectedTransactions.begin(details.tabId, 'popup-target', sourceOrigin ? hostFromUrl(sourceOrigin) : undefined);
    }
    const sourceEpoch = navRegistry.getEpoch(details.sourceTabId, details.sourceFrameId);
    const target = intentTracker.correlate({
      sourceTabId: details.sourceTabId,
      sourceFrameId: details.sourceFrameId,
      sourceDocumentId: sourceEpoch?.documentId,
      targetTabId: details.tabId,
      url: details.url,
      timeStamp: details.timeStamp,
      sourceOrigin: sourceEpoch?.origin,
      openerRelationship: 'implicit',
      foregroundState: 'unknown',
    });
    navigationTargets.record(target, details.url);
    await causalOrchestrator.onNavigationTarget(target);
    const classification = classifyNavigationTarget(target);
    // The autonomous executor owns destructive target actions. This listener
    // only records the causal classification and never bypasses the policy
    // and rollback path.
    await causalOrchestrator.onNavigationTargetClassification(target, classification);
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await startupReady;
  await protectedTransactions.onTabRemoved(tabId);
  navRegistry.onTabClosed(tabId);
  navigationTargets.clearTab(tabId);
  await causalEngine.onTabClosed(tabId);
  const activeTxs = adaptEngine.getActiveTransactions().filter((tx) => tx.tabId === tabId);
  for (const tx of activeTxs) {
    if (tx.sessionRuleIds.length > 0) {
      await dnrController.removeSessionExperimentRules(tx.sessionRuleIds, 'tab-close-cleanup').catch(() => {});
    }
  }
  await causalSession.persist().catch(() => {});
});

// WebRequest Telemetry Listeners
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Dev-only forensics: probe whether any learned session rule matches this request.
    // Runs only while learned rules exist; the raw URL never leaves the browser.
    if (forensics.enabled && forensics.hasLearnedRules() && details.tabId >= 0
      && typeof chrome.declarativeNetRequest.testMatchOutcome === 'function') {
      forensics.count('matchProbes');
      void chrome.declarativeNetRequest.testMatchOutcome({
        url: details.url,
        type: details.type as chrome.declarativeNetRequest.ResourceType,
        tabId: details.tabId,
        ...(details.initiator ? { initiator: details.initiator } : {}),
      }).then((outcome) => {
        forensics.learnedMatch(outcome.matchedRules.map((rule) => rule.ruleId), details.url);
      }).catch(() => undefined);
    }
    const capturedEpoch = details.type === 'main_frame'
      ? undefined
      : navRegistry.getEpoch(details.tabId, details.frameId);
    if (capturedEpoch) requestEpochs.set(details.requestId, capturedEpoch);
    // Personal learned-rule match observation — in-memory index only, no storage
    // reads on the hot path; metadata writes are debounced inside the store.
    personalLearning.observeRequestInitiation(details.url, details.type, details.initiator, details.requestId);
    void startupReady.then(async () => {
      requestObserver.handleBeforeRequest(details);
      const scoped = details as chrome.webRequest.WebRequestBodyDetails & { documentId?: string };
      await causalOrchestrator.onRequest({
        type: 'start', tabId: details.tabId, frameId: details.frameId,
        requestId: details.requestId, url: details.url, documentId: scoped.documentId,
        resourceType: details.type, timeStamp: details.timeStamp, initiator: details.initiator,
        parentFrameId: (details as chrome.webRequest.WebRequestBodyDetails & { parentFrameId?: number }).parentFrameId,
      }, causalResources, capturedEpoch);
    });
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const capturedEpoch = requestEpochs.get(details.requestId) ?? navRegistry.getEpoch(details.tabId, details.frameId);
    requestEpochs.delete(details.requestId);
    // A blocker-style error on a learned family is direct evidence the personal rule
    // suppressed the request (production-safe match signal — no dev-only DNR APIs).
    if (details.error === 'net::ERR_BLOCKED_BY_CLIENT') {
      personalLearning.observeBlocked(details.url, details.type, details.initiator, details.requestId, details.tabId);
      if (details.type === 'script') {
        const requestDocumentId = (details as chrome.webRequest.WebResponseErrorDetails & { documentId?: string }).documentId;
        stealthProfiles.noteBlockedScript(details.tabId, details.url, requestDocumentId);
        if (forensics.enabled) forensics.event('STEALTH_BLOCK_NOTED', { tab: details.tabId, urlHash: forensics.hash(details.url) });
      }
    }
    void startupReady.then(async () => {
      requestObserver.handleErrorOccurred(details);
      const scoped = details as chrome.webRequest.WebResponseErrorDetails & { documentId?: string };
      await causalOrchestrator.onRequest({
        type: 'error', tabId: details.tabId, frameId: details.frameId,
        requestId: details.requestId, url: details.url, documentId: scoped.documentId,
        resourceType: details.type, timeStamp: details.timeStamp, error: details.error,
        initiator: details.initiator,
        parentFrameId: (details as chrome.webRequest.WebResponseErrorDetails & { parentFrameId?: number }).parentFrameId,
      }, causalResources, capturedEpoch);
    });
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const capturedEpoch = requestEpochs.get(details.requestId) ?? navRegistry.getEpoch(details.tabId, details.frameId);
    requestEpochs.delete(details.requestId);
    void startupReady.then(async () => {
      requestObserver.handleCompleted(details);
      const scoped = details as chrome.webRequest.WebResponseCacheDetails & { documentId?: string };
      await causalOrchestrator.onRequest({
        type: 'complete', tabId: details.tabId, frameId: details.frameId,
        requestId: details.requestId, url: details.url, documentId: scoped.documentId,
        resourceType: details.type, timeStamp: details.timeStamp, initiator: details.initiator,
        parentFrameId: (details as chrome.webRequest.WebResponseCacheDetails & { parentFrameId?: number }).parentFrameId,
        statusCode: details.statusCode,
        fromCache: details.fromCache,
      }, causalResources, capturedEpoch);
    });
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

// Content Script IPC Listener
chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, sender, sendResponse) => {
  if (!message || message.v !== 1 || !sender.tab || sender.tab.id === undefined) {
    return false;
  }
  if (message.type === 'PAGE_FILTER_MAIN_SCRIPTLET') {
    const tabId = sender.tab.id;
    const frameId = sender.frameId || 0;
    const senderDocumentId = (sender as chrome.runtime.MessageSender & { documentId?: string }).documentId;
    if (!ALLOWED_MAIN_SCRIPTLETS.has(message.name) || message.args.length > 5 || message.args.some((arg) => typeof arg !== 'string' || arg.length > 1000)) {
      sendResponse({ success: false });
      return false;
    }
    void chrome.scripting.executeScript({
      target: senderDocumentId ? { tabId, documentIds: [senderDocumentId] } : { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: runMainScriptlet,
      args: [message.name, message.args],
    }).then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
    return true;
  }
  if (message.type === 'COSMETIC_REPLAY_GET' || message.type === 'COSMETIC_REPLAY_OUTCOME') {
    const tabId = sender.tab.id;
    const pageUrl = sender.tab.url || '';
    // Narrow gate, same reasoning as the stealth handlers: replay breakage must
    // be answerable while the rest of startup is still running.
    void cosmeticProfiles.load().then(async () => {
      if (message.type === 'COSMETIC_REPLAY_GET') {
        // Only the selectors actually injected for this navigation — the guard
        // must never evaluate anything the plane did not hide itself.
        const injected = tabId !== undefined ? cosmeticReplayByTab.get(tabId) : undefined;
        sendResponse({ selectors: injected?.selectors ?? [] });
        return;
      }
      const matched = Array.isArray(message.matched) ? message.matched.filter((item) => typeof item === 'string').slice(0, 12) : [];
      const missed = Array.isArray(message.missed) ? message.missed.filter((item) => typeof item === 'string').slice(0, 12) : [];
      if (message.broke === true && tabId !== undefined) {
        // Rollback guard: un-hide immediately, then let the failure bookkeeping
        // decide whether the rule survives.
        const injected = cosmeticReplayByTab.get(tabId);
        if (injected) {
          void chrome.scripting.removeCSS({ target: { tabId, frameIds: [0] }, css: injected.css }).catch(() => undefined);
        }
        if (forensics.enabled) forensics.count('cosmeticReplayBroke');
      }
      cosmeticProfiles.noteReplayOutcome(pageUrl, message.broke === true, matched, missed);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message.type === 'STEALTH_PROFILE_GET' || message.type === 'STEALTH_BAIT_CANDIDATES' || message.type === 'STEALTH_REPLAY_OUTCOME') {
    const tabId = sender.tab.id;
    const pageUrl = sender.tab.url || '';
    // Narrow gate: stealth learn/replay only needs its own store, not full
    // startup (engine init, planner load). Detector checkers fire 1-2s after
    // parse — waiting on full startup loses that race on a cold worker.
    void stealthProfiles.load().then(async () => {
      if (message.type === 'STEALTH_PROFILE_GET') {
        sendResponse(stealthProfiles.replayFor(pageUrl));
      } else if (message.type === 'STEALTH_BAIT_CANDIDATES') {
        const candidates = Array.isArray(message.candidates) ? message.candidates.filter((c) => typeof c === 'string').slice(0, 8) : [];
        // The bait's network-block event can still be in flight when the
        // DOMContentLoaded scan arrives (cold worker start, event ordering).
        // Settle briefly instead of hard-refusing — the blocked-script gate
        // still applies, just without the race.
        const startedAt = Date.now();
        let hadContext = stealthProfiles.hadBlockedScript(tabId);
        for (let attempt = 0; attempt < 8 && !hadContext; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 75));
          hadContext = stealthProfiles.hadBlockedScript(tabId);
        }
        const accepted = stealthProfiles.learn(tabId, pageUrl, candidates);
        if (forensics.enabled) {
          forensics.event('STEALTH_LEARN_ATTEMPT', {
            tab: tabId,
            pageHash: forensics.hash(pageUrl),
            hadContext,
            waitedMs: Date.now() - startedAt,
            candidateCount: candidates.length,
            acceptedCount: accepted.length,
          });
        }
        sendResponse({ accepted });
      } else {
        stealthProfiles.noteReplayOutcome(pageUrl, message.wallSeen === true);
        sendResponse({ ok: true });
      }
    });
    return true;
  }
  const tabId = sender.tab.id;
  const frameId = sender.frameId || 0;
  const senderDocumentId = (sender as chrome.runtime.MessageSender & { documentId?: string }).documentId;
  const messageUrl = message.type === 'PAGE_SENSOR_READY' ? message.url : sender.tab.url || '';
  void startupReady.then(async () => {
    // Epoch capture waits for startup so a commit handler queued during boot
    // runs first, and the liveness check inside captureContentEpoch sees the
    // post-navigation frame state. A dead document's message gets no epoch.
    const epoch = await captureContentEpoch(tabId, frameId, message.navigationId, messageUrl, senderDocumentId);
    if (!epoch) {
      sendResponse({ success: false, error: 'stale-document' });
      return;
    }
    const siteKey = extractSiteKey(epoch.url);
    switch (message.type) {
    case 'PAGE_SENSOR_READY': {
      // Replay confirmed recipe once sensor is confirmed ready in DOM.
      // Throttled per document: hashchange floods from the same document
      // coalesce to at most one replay per READY_REPLAY_MIN_INTERVAL_MS, and
      // the replay txId is document-scoped so concurrent tabs/documents on the
      // same site can never share a transaction id.
      if (siteKey) {
        const documentKey = epoch.documentId ?? epoch.navigationId;
        const throttleKey = `${tabId}:${documentKey}`;
        const now = Date.now();
        const lastReplay = readyReplayThrottle.get(throttleKey) ?? 0;
        if (now - lastReplay >= READY_REPLAY_MIN_INTERVAL_MS) {
          readyReplayThrottle.set(throttleKey, now);
          while (readyReplayThrottle.size > READY_REPLAY_THROTTLE_MAX_KEYS) {
            const oldestKey = readyReplayThrottle.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            readyReplayThrottle.delete(oldestKey);
          }
          const replayTxId = `recipe_replay_${siteKey}_${documentKey}`;
          recipeStore.getRecipe(siteKey).then((recipe) => {
            if (recipe && (recipe.state === 'confirmed' || recipe.state === 'provisional')) {
              const domActions = recipe.actions.filter((a) => a.type.startsWith('DOM_'));
              for (const action of domActions) {
                sendTabMessage(tabId, {
                  v: 1,
                  type: 'APPLY_DOM_ACTION',
                  txId: replayTxId,
                  payload: action,
                });
              }
            }
          });
        }
      }
      sendResponse({ success: true, navigationId: epoch.navigationId, documentId: epoch.documentId });
      break;
    }

    case 'PAGE_SIGNAL_BATCH': {
      // Correlate with canonical navigation epoch
      if (!isPageSignalBatch(message.payload)) break;
      await causalQueues.get(tabId)?.catch(() => {});
      const causal = causalHandledBatches.get(tabId);
      const handled = causal?.get(message.payload.timestamp);
      if (handled !== undefined) {
        causal?.delete(message.payload.timestamp);
        if (causal?.size === 0) causalHandledBatches.delete(tabId);
        if (handled) break;
      }
      // Protected Transaction Mode: the engine path stages no experiments while
      // a deliberate auth/payment/captcha flow is active on this tab.
      if (protectedTransactions.isActive(tabId)) break;
      // Per-site pause: user-declared stand-down for this host.
      if (pauseManager.isPaused(siteKey)) break;
      await adaptEngine.evaluateSignals(tabId, epoch.navigationId, siteKey, message.payload);
      break;
    }

    case 'USER_INTENT_ENVELOPE': {
      if (!isUserIntentEnvelope(message.payload)) break;
      const documentId = senderDocumentId ?? epoch.documentId;
      intentTracker.record(tabId, frameId, documentId, message.payload);
      await causalOrchestrator.onIntentEnvelope(tabId, frameId, message.payload);
      break;
    }

    case 'PROTECTED_TRANSACTION_INTENT': {
      // Trusted click on a flow-shaped element ("Sign in with…", "Pay") — the
      // tab enters conservative mode even if no protected-host navigation ever
      // happens (same-tab checkout, 3DS iframe on an unenumerable bank host).
      const origin = navRegistry.getEpoch(tabId, 0)?.origin;
      await protectedTransactions.begin(tabId, 'intent', origin ? hostFromUrl(origin) : undefined);
      break;
    }

    case 'CAUSAL_OBSERVATION_BATCH': {
      if (!isPageSignalBatch(message.payload?.pageSignals) || !Array.isArray(message.payload.elements)) break;
      const previous = causalQueues.get(tabId) ?? Promise.resolve(false);
      const queued = previous
        .catch(() => false)
        .then(() => causalOrchestrator.onPageObservation(tabId, frameId, message.payload, epoch))
        .then((handled) => {
          const batches = causalHandledBatches.get(tabId) ?? new Map<number, boolean>();
          batches.set(message.payload.pageSignals.timestamp, handled);
          // Keep this transient correlation cache bounded even if a content
          // script is destroyed before its paired PAGE_SIGNAL_BATCH arrives.
          while (batches.size > 32) batches.delete(batches.keys().next().value as number);
          causalHandledBatches.set(tabId, batches);
          return handled;
        });
      causalQueues.set(tabId, queued);
      await queued.finally(() => {
        if (causalQueues.get(tabId) === queued) causalQueues.delete(tabId);
      });
      break;
    }

    case 'HEALTH_SNAPSHOT': {
      if (message.txId && isHealthVector(message.payload)) {
        const handled = await causalOrchestrator.onHealthSnapshot(tabId, frameId, message.txId, message.payload);
        if (!handled) await adaptEngine.verifyAndCompleteTransaction(message.txId, message.payload);
      }
      break;
    }
    case 'DOM_ACTION_RESULT':
      // Phase E: hide-type actions ack the stable selectors they applied.
      // Held as pending until the outcome verifier confirms healthy (learn) or
      // rolls back (discard) — the verdict hooks live in the orchestrator.
      if (message.operation === 'apply' && message.success && Array.isArray(message.hideSelectors) && message.hideSelectors.length > 0) {
        cosmeticProfiles.noteAppliedHides(message.txId, messageUrl, message.hideSelectors);
      }
      // P4: post-hoc re-hide telemetry (carries no hideSelectors — no learning side effect).
      if (typeof message.reHideCount === 'number' && message.reHideCount > 0) {
        forensics.count('reinsertionsSuppressed', message.reHideCount);
        forensics.event('REINSERTION_REHIDES_SETTLED', { count: message.reHideCount });
      }
      break;
    }
    sendResponse({ success: true });
  }).catch((error: unknown) => {
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'background-error' });
  });
  return true;
});

// Startup / Worker Wakeup Initialization & Reconciliation
(async () => {
  try {
    await startupReady;
    // A failed reconcile (transient Chrome read error) leaves the allocator
    // unaware of live rules. Retry a few times within this worker's lifetime
    // instead of waiting for the next wake — collisions fail closed in Chrome,
    // but every failed staging in between is protection the user never got.
    let result = await dnrController.restoreOwnershipAndReconcile();
    for (let attempt = 0; result && !result.reconciledSuccessfully && attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
      result = await dnrController.restoreOwnershipAndReconcile();
    }
    personalLearning.rebuildIndex();
    // Session rules left STAGED by a dead worker are unverifiable — roll them
    // back before any new staging trusts the reconciled state.
    const settledUnverified = await personalLearning.settleUnverifiedStagedRules().catch(() => 0);
    // Protected-flow self-heal: profiles that learned rules against dedicated
    // authentication hosts before the guard existed keep broken sign-in flows
    // forever otherwise — revoke them (records kept as REVOKED for evidence).
    const protectedPurged = await dnrController.purgeProtectedAuthRules().catch(() => 0);
    // Transaction-mode settle: remove any allowance rules stranded by a worker
    // suspension (fail closed to normal protection; a mid-flow tab re-begins on
    // its next protected navigation).
    const protectedTxSettled = await protectedTransactions.settleOnWorkerStart().catch(() => 0);
    // Per-site pause: reconcile the durable allowance rules with the stored list
    // (re-assert evicted rules, remove orphans of removed hosts).
    await pauseManager.settleFromStorage().catch(() => undefined);
    const demoted = await personalLearning.sweepDecay().catch(() => 0);
    if (forensics.enabled && result) {
      forensics.unmarkLearnedRules(result.orphanedSessionRulesRemoved, 'startup-reconcile');
      forensics.count('sessionRulesRemovedByReconcile', result.orphanedSessionRulesRemoved.length);
      forensics.count('sessionRulesRestoredAfterWorkerRestart', result.restoredSessionRuleIds.length);
      forensics.count('dynamicRulesRestoredAfterBrowserRestart', result.restoredDynamicRuleIds.length);
      forensics.event('RECONCILE_RESULT', {
        reconciled: result.reconciledSuccessfully,
        orphanedSessionRemoved: result.orphanedSessionRulesRemoved.length,
        orphanedDynamicRemoved: result.orphanedDynamicRulesRemoved.length,
        sessionRestored: result.restoredSessionRuleIds.length,
        dynamicRestored: result.restoredDynamicRuleIds.length,
        unknownKept: result.unknownRuleIdsKept.length,
        metadataCleaned: result.metadataRecordsCleaned.length,
        promotingResolved: result.promotingRecordsResolved.length,
        foreignSchemaProtected: result.foreignSchemaProtected,
        settledUnverified,
        protectedPurged,
        protectedTxSettled,
        demoted,
        sessionRuleIds: result.orphanedSessionRulesRemoved.join(','),
      });
      if (result.promotingRecordsResolved.length > 0) {
        forensics.count('promotingRecordsSettledAtStartup', result.promotingRecordsResolved.length);
      }
      forensics.event('PERSONAL_RULE_COUNT', { count: personalLearning.personalRuleCount() });
      void forensics.snapshotSessionRules('post-reconcile');
      void forensics.flush();
    }
  } catch {
    // Startup recovery safe fallback
  }
})();
