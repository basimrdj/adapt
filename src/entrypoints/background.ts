import { NavigationRegistry } from '../core/navigation/registry';
import { RequestGraphManager } from '../core/network/request-graph';
import { RequestObserver } from '../core/network/observer';
import { DnrController } from '../core/dnr/controller';
import { RecipeStore } from '../core/recipes/store';
import { AuditStore } from '../core/audit/store';
import { AdaptationTransactionEngine } from '../core/adaptation/engine';
import { extractSiteKey } from '../core/navigation/epoch';
import { ContentToBackgroundMessage } from '../shared/messages';

// 1. Storage Backend Implementation for chrome.storage.local
const chromeStorageBackend = {
  get: async (keys: string[]) => {
    return new Promise<Record<string, unknown>>((res) => {
      chrome.storage.local.get(keys, (items) => res(items || {}));
    });
  },
  set: async (items: Record<string, unknown>) => {
    return new Promise<void>((res) => {
      chrome.storage.local.set(items, () => res());
    });
  },
  remove: async (keys: string[]) => {
    return new Promise<void>((res) => {
      chrome.storage.local.remove(keys, () => res());
    });
  },
};

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
  return new Promise<void>((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, () => {
      // Safe ignore if tab closed
      resolve();
    });
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
  sendTabMessage
);

// 5. Synchronous Top-Level Service Worker Listeners

// WebNavigation Lifecycle
chrome.webNavigation.onCommitted.addListener(async (details) => {
  const parentFrameId = 'parentFrameId' in details ? (details as { parentFrameId: number }).parentFrameId : undefined;
  const epoch = navRegistry.onNavigationCommitted(
    details.tabId,
    details.frameId,
    details.url,
    parentFrameId
  );

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
  navRegistry.onHistoryStateUpdated(details.tabId, details.frameId, details.url);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  navRegistry.onTabClosed(tabId);
  const activeTxs = adaptEngine.getActiveTransactions().filter((tx) => tx.tabId === tabId);
  for (const tx of activeTxs) {
    if (tx.sessionRuleIds.length > 0) {
      await dnrController.removeSessionExperimentRules(tx.sessionRuleIds).catch(() => {});
    }
  }
});

// WebRequest Telemetry Listeners
chrome.webRequest.onBeforeRequest.addListener(
  (details) => requestObserver.handleBeforeRequest(details),
  { urls: ['http://*/*', 'https://*/*'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => requestObserver.handleErrorOccurred(details),
  { urls: ['http://*/*', 'https://*/*'] }
);

// Content Script IPC Listener
chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, sender) => {
  if (!message || message.v !== 1 || !sender.tab || sender.tab.id === undefined) {
    return;
  }

  const tabId = sender.tab.id;
  const frameId = sender.frameId || 0;
  const url = sender.tab.url || (message.type === 'PAGE_SENSOR_READY' ? message.url : '');
  const siteKey = extractSiteKey(url);

  // Validate or retrieve canonical Navigation Epoch
  let epoch = navRegistry.getEpoch(tabId, frameId);
  if (!epoch) {
    epoch = navRegistry.onNavigationCommitted(tabId, frameId, url);
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
      break;
    }

    case 'PAGE_SIGNAL_BATCH': {
      // Correlate with canonical navigation epoch
      const canonicalNavId = epoch.navigationId;
      adaptEngine.evaluateSignals(tabId, canonicalNavId, siteKey, message.payload);
      break;
    }

    case 'HEALTH_SNAPSHOT': {
      if (message.txId) {
        adaptEngine.verifyAndCompleteTransaction(message.txId, message.payload);
      }
      break;
    }
  }
});

// Startup / Worker Wakeup Initialization & Reconciliation
(async () => {
  try {
    await adaptEngine.init();
    const activeTxs = adaptEngine.getActiveTransactions();
    const activeTxIds = new Set(activeTxs.map((t) => t.txId));
    await dnrController.reconcile(activeTxIds);
  } catch {
    // Startup recovery safe fallback
  }
})();
