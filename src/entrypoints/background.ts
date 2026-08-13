import { NavigationRegistry } from '../core/navigation/registry';
import { RequestGraphManager } from '../core/network/request-graph';
import { RequestObserver } from '../core/network/observer';
import { DnrController } from '../core/dnr/controller';
import { RecipeStore } from '../core/recipes/store';
import { AuditStore } from '../core/audit/store';
import { AdaptationTransactionEngine } from '../core/adaptation/engine';
import { extractSiteKey } from '../core/navigation/epoch';
import { ContentToBackgroundMessage } from '../shared/messages';
import { ChromeStorageBackend } from '../background/storage/chrome-storage';
import { EpochRouter } from '../background/causal/epoch-router';
import { EventGraphStore } from '../background/causal/graph-store';
import { BeliefUpdater } from '../background/causal/belief-updater';
import { CausalSessionStateRepository } from '../background/causal/session-state';
import { CausalEngine } from '../background/causal/causal-engine';
import { CausalOrchestrator, CausalResourceRegistry } from '../background/causal/orchestrator';
import { CausalRecipeStore, PromotionGate } from '../background/causal/promotion-gate';
import { isHealthVector, isPageSignalBatch } from '../shared/guards';
import { reconcilePhase31StaticRulesets } from '../background/phase31/static-rulesets';

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
const sendTabMessage = async (tabId: number, msg: unknown) => {
  return new Promise<void>((resolve, reject) => {
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
      if (!response || response.success !== true) {
        reject(new Error('Content script did not acknowledge action'));
        return;
      }
      resolve();
    };
    if (documentId) chrome.tabs.sendMessage(tabId, msg, { documentId }, callback);
    else chrome.tabs.sendMessage(tabId, msg, callback);
  });
};

// 4. Instantiate Core Domain Modules
const navRegistry = new NavigationRegistry();
const graphManager = new RequestGraphManager();
const requestObserver = new RequestObserver(navRegistry, graphManager);
const dnrController = new DnrController(chromeDnrBackend);
const recipeStore = new RecipeStore(chromeStorageBackend);
const auditStore = new AuditStore(chromeStorageBackend);
const adaptEngine = new AdaptationTransactionEngine(
  dnrController,
  recipeStore,
  auditStore,
  chromeStorageBackend,
  sendTabMessage,
  undefined,
  (tabId, navigationId) => navRegistry.isEpochValid(tabId, navigationId)
);
const causalResources = new CausalResourceRegistry();
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
  runFallback: (tabId, navigationId, siteKey, batch) =>
    adaptEngine.evaluateSignals(tabId, navigationId, siteKey, batch),
});
const startupReady = (async () => {
  await causalSession.restore().catch(() => false);
  await adaptEngine.init();
  await causalEngine.init();
  await reconcilePhase31StaticRulesets();
})();
const causalQueues = new Map<number, Promise<boolean>>();
const causalHandledBatches = new Map<number, Map<number, boolean>>();

// 5. Synchronous Top-Level Service Worker Listeners

// WebNavigation Lifecycle
chrome.webNavigation.onCommitted.addListener(async (details) => {
  await startupReady;
  const previous = navRegistry.getCausalKey(details.tabId, details.frameId);
  if (!previous || previous.documentId !== details.documentId) {
    await causalEngine.onNavigation(details.tabId, previous);
  }
  const parentFrameId = 'parentFrameId' in details ? (details as { parentFrameId: number }).parentFrameId : undefined;
  const epoch = navRegistry.onNavigationCommitted(
    details.tabId,
    details.frameId,
    details.url,
    parentFrameId,
    details.documentId
  );
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

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await startupReady;
  navRegistry.onTabClosed(tabId);
  const activeTxs = adaptEngine.getActiveTransactions().filter((tx) => tx.tabId === tabId);
  for (const tx of activeTxs) {
    if (tx.sessionRuleIds.length > 0) {
      await dnrController.removeSessionExperimentRules(tx.sessionRuleIds).catch(() => {});
    }
  }
  await causalSession.persist().catch(() => {});
});

// WebRequest Telemetry Listeners
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    void startupReady.then(async () => {
      requestObserver.handleBeforeRequest(details);
      const scoped = details as chrome.webRequest.WebRequestBodyDetails & { documentId?: string };
      await causalOrchestrator.onRequest({
        type: 'start', tabId: details.tabId, frameId: details.frameId,
        requestId: details.requestId, url: details.url, documentId: scoped.documentId,
        resourceType: details.type, timeStamp: details.timeStamp, initiator: details.initiator,
      }, causalResources);
    });
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    void startupReady.then(async () => {
      requestObserver.handleErrorOccurred(details);
      const scoped = details as chrome.webRequest.WebResponseErrorDetails & { documentId?: string };
      await causalOrchestrator.onRequest({
        type: 'error', tabId: details.tabId, frameId: details.frameId,
        requestId: details.requestId, url: details.url, documentId: scoped.documentId,
        resourceType: details.type, timeStamp: details.timeStamp, error: details.error,
        initiator: details.initiator,
      }, causalResources);
    });
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    void startupReady.then(async () => {
      requestObserver.handleCompleted(details);
      const scoped = details as chrome.webRequest.WebResponseCacheDetails & { documentId?: string };
      await causalOrchestrator.onRequest({
        type: 'complete', tabId: details.tabId, frameId: details.frameId,
        requestId: details.requestId, url: details.url, documentId: scoped.documentId,
        resourceType: details.type, timeStamp: details.timeStamp, initiator: details.initiator,
      }, causalResources);
    });
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

// Content Script IPC Listener
chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, sender, sendResponse) => {
  if (!message || message.v !== 1 || !sender.tab || sender.tab.id === undefined) {
    return false;
  }
  void startupReady.then(async () => {
    const tabId = sender.tab!.id!;
    const frameId = sender.frameId || 0;
    const url = sender.tab!.url || (message.type === 'PAGE_SENSOR_READY' ? message.url : '');
    const siteKey = extractSiteKey(url);
    const senderDocumentId = (sender as chrome.runtime.MessageSender & { documentId?: string }).documentId;
    let epoch = navRegistry.getEpoch(tabId, frameId);
    if (!epoch) epoch = navRegistry.onNavigationCommitted(tabId, frameId, url, undefined, senderDocumentId);
    if (senderDocumentId && senderDocumentId !== epoch.documentId) {
      sendResponse({ success: false, error: 'stale-document' });
      return;
    }

    switch (message.type) {
    case 'PAGE_SENSOR_READY': {
      // Replay confirmed recipe once sensor is confirmed ready in DOM
      if (siteKey) {
        recipeStore.getRecipe(siteKey).then((recipe) => {
          if (recipe && (recipe.state === 'confirmed' || recipe.state === 'provisional')) {
            const domActions = recipe.actions.filter((a) => a.type.startsWith('DOM_'));
            for (const action of domActions) {
              sendTabMessage(tabId, {
                v: 1,
                type: 'APPLY_DOM_ACTION',
                txId: `recipe_replay_${siteKey}`,
                payload: action,
              });
            }
          }
        });
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
      await adaptEngine.evaluateSignals(tabId, epoch.navigationId, siteKey, message.payload);
      break;
    }

    case 'CAUSAL_OBSERVATION_BATCH': {
      if (!isPageSignalBatch(message.payload?.pageSignals) || !Array.isArray(message.payload.elements)) break;
      const previous = causalQueues.get(tabId) ?? Promise.resolve(false);
      const queued = previous
        .catch(() => false)
        .then(() => causalOrchestrator.onPageObservation(tabId, frameId, message.payload))
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
    const activeTxs = adaptEngine.getActiveTransactions();
    const activeTxIds = new Set(activeTxs.map((t) => t.txId));
    await dnrController.reconcile(activeTxIds);
  } catch {
    // Startup recovery safe fallback
  }
})();
