import { NavigationRegistry } from '../navigation/registry';
import { RequestGraphManager } from './request-graph';

export class RequestObserver {
  private navRegistry: NavigationRegistry;
  private graphManager: RequestGraphManager;

  constructor(navRegistry: NavigationRegistry, graphManager: RequestGraphManager) {
    this.navRegistry = navRegistry;
    this.graphManager = graphManager;
  }

  public handleBeforeRequest(details: chrome.webRequest.WebRequestBodyDetails): void {
    if (details.tabId < 0) return;
    const epoch = this.navRegistry.getEpoch(details.tabId, details.frameId);
    if (!epoch) return;

    this.graphManager.recordRequest(
      epoch.navigationId,
      details.tabId,
      details.requestId,
      details.url,
      details.type,
      details.initiator
    );
  }

  public handleErrorOccurred(details: chrome.webRequest.WebResponseErrorDetails): void {
    if (details.tabId < 0) return;
    const epoch = this.navRegistry.getEpoch(details.tabId, details.frameId);
    if (!epoch) return;

    const isBlocked = details.error === 'net::ERR_BLOCKED_BY_CLIENT';
    this.graphManager.recordBlockedOrError(
      epoch.navigationId,
      details.tabId,
      details.url,
      isBlocked
    );
  }
}
