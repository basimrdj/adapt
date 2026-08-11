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
      // Ignore errors if tab closed/reloaded
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
const adaptEngine = new AdaptationTransactionEngine(dnrController, recipeStore, auditStore, sendTabMessage);

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

  // If main frame committed, check if we have a confirmed recipe to replay
  if (epoch.isMainFrame && epoch.siteKey) {
    const recipe = await recipeStore.getRecipe(epoch.siteKey);
    if (recipe && (recipe.state === 'confirmed' || recipe.state === 'provisional')) {
      // Apply recipe DOM actions to page
      const domActions = recipe.actions.filter((a) => a.type.startsWith('DOM_'));
      for (const action of domActions) {
        sendTabMessage(details.tabId, {
          v: 1,
          type: 'APPLY_DOM_ACTION',
          txId: `recipe_replay_${epoch.siteKey}`,
          payload: action,
        });
      }
    }
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  navRegistry.onHistoryStateUpdated(details.tabId, details.frameId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  navRegistry.onTabClosed(tabId);
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
  const url = sender.tab.url || '';
  const siteKey = extractSiteKey(url);

  switch (message.type) {
    case 'PAGE_SIGNAL_BATCH': {
      adaptEngine.evaluateSignals(tabId, message.navigationId, siteKey, message.payload);
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

// Startup / Worker Wakeup Reconciliation
dnrController.reconcile(new Set()).catch(() => {
  // Safe error catch
});
