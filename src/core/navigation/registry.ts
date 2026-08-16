import { CausalDocumentKey } from '../../shared/causal/events';
import { NavigationEpoch } from '../../shared/types';
import { createNavigationEpoch, isSyntheticDocumentId } from './epoch';

export class NavigationRegistry {
  // Key: tabId -> Map<frameId, NavigationEpoch>
  private activeEpochs = new Map<number, Map<number, NavigationEpoch>>();
  /** Per-tab monotonic navigationEpoch counter. Starts at 1. Never uses processId. */
  private epochCounters = new Map<number, number>();
  private documentAliases = new Map<string, string>();

  private documentAliasKey(tabId: number, frameId: number, documentId: string): string {
    return `${tabId}\u0000${frameId}\u0000${documentId}`;
  }

  private sameDocumentUrl(existingUrl: string, incomingUrl: string): boolean {
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

  public reconcileDocumentId(
    tabId: number,
    frameId: number,
    url: string,
    documentId?: string
  ): boolean {
    if (!documentId) return false;
    const existing = this.getEpoch(tabId, frameId);
    if (!existing || !isSyntheticDocumentId(existing.documentId) || !this.sameDocumentUrl(existing.url, url)) {
      return false;
    }
    this.documentAliases.set(this.documentAliasKey(tabId, frameId, documentId), existing.documentId);
    existing.url = url;
    return true;
  }

  public aliasDocumentId(
    tabId: number,
    frameId: number,
    url: string,
    documentId?: string
  ): boolean {
    if (!documentId) return false;
    const existing = this.getEpoch(tabId, frameId);
    if (!existing || !this.sameDocumentUrl(existing.url, url)) return false;
    this.documentAliases.set(this.documentAliasKey(tabId, frameId, documentId), existing.documentId);
    return true;
  }

  public matchesDocumentId(tabId: number, frameId: number, documentId?: string): boolean {
    if (!documentId) return true;
    const existing = this.getEpoch(tabId, frameId);
    if (!existing) return false;
    return existing.documentId === documentId
      || this.documentAliases.get(this.documentAliasKey(tabId, frameId, documentId)) === existing.documentId;
  }

  private nextNavigationEpoch(tabId: number): number {
    const next = (this.epochCounters.get(tabId) ?? 0) + 1;
    this.epochCounters.set(tabId, next);
    return next;
  }

  public onNavigationCommitted(
    tabId: number,
    frameId: number,
    url: string,
    parentFrameId?: number,
    documentId?: string
  ): NavigationEpoch {
    if (!this.activeEpochs.has(tabId)) {
      this.activeEpochs.set(tabId, new Map());
    }

    const frameMap = this.activeEpochs.get(tabId)!;
    const existing = frameMap.get(frameId);
    // Runtime IPC can wake the worker before the async onCommitted handler
    // resumes. The later Chrome event is the same document commit.
    if (documentId && existing?.documentId === documentId) {
      existing.url = url;
      return existing;
    }
    if (existing && !documentId && this.sameDocumentUrl(existing.url, url)) {
      existing.url = url;
      return existing;
    }
    if (this.reconcileDocumentId(tabId, frameId, url, documentId)) {
      return frameMap.get(frameId)!;
    }
    // If main frame navigates, clear all subframe epochs for this tab
    if (frameId === 0) {
      frameMap.clear();
      for (const key of this.documentAliases.keys()) {
        if (key.startsWith(`${tabId}\u0000`)) this.documentAliases.delete(key);
      }
    }

    const epoch = createNavigationEpoch(
      tabId,
      frameId,
      url,
      parentFrameId,
      documentId,
      this.nextNavigationEpoch(tabId)
    );
    frameMap.set(frameId, epoch);
    return epoch;
  }

  public onHistoryStateUpdated(tabId: number, frameId: number, url: string): NavigationEpoch | null {
    const frameMap = this.activeEpochs.get(tabId);
    if (!frameMap) return null;

    const existing = frameMap.get(frameId);
    if (!existing) return null;

    // SPA route change: same document (documentId unchanged), new navigation epoch + navigationId.
    const updatedEpoch = createNavigationEpoch(
      tabId,
      frameId,
      url,
      existing.parentFrameId,
      existing.documentId,
      this.nextNavigationEpoch(tabId)
    );
    frameMap.set(frameId, updatedEpoch);
    return updatedEpoch;
  }

  public getEpoch(tabId: number, frameId = 0): NavigationEpoch | undefined {
    return this.activeEpochs.get(tabId)?.get(frameId);
  }

  public getCausalKey(tabId: number, frameId = 0): CausalDocumentKey | undefined {
    const epoch = this.getEpoch(tabId, frameId);
    if (!epoch) return undefined;
    return {
      tabId: epoch.tabId,
      navigationEpoch: epoch.navigationEpoch,
      documentId: epoch.documentId,
      frameId: epoch.frameId,
    };
  }

  public isEpochValid(tabId: number, navigationId: string, frameId = 0): boolean {
    const epoch = this.getEpoch(tabId, frameId);
    return epoch !== undefined && epoch.navigationId === navigationId;
  }

  public isCausalScopeValid(scope: CausalDocumentKey): boolean {
    const live = this.getCausalKey(scope.tabId, scope.frameId);
    if (!live) return false;
    return (
      live.tabId === scope.tabId &&
      live.frameId === scope.frameId &&
      live.documentId === scope.documentId &&
      live.navigationEpoch === scope.navigationEpoch
    );
  }

  public onTabClosed(tabId: number): void {
    this.activeEpochs.delete(tabId);
    this.epochCounters.delete(tabId);
    for (const key of this.documentAliases.keys()) {
      if (key.startsWith(`${tabId}\u0000`)) this.documentAliases.delete(key);
    }
  }

  public getActiveTabIds(): number[] {
    return Array.from(this.activeEpochs.keys());
  }

  public snapshot(): { epochs: NavigationEpoch[]; counters: Array<[number, number]> } {
    const epochs: NavigationEpoch[] = [];
    for (const frameMap of this.activeEpochs.values()) {
      for (const epoch of frameMap.values()) epochs.push({ ...epoch });
    }
    return { epochs, counters: Array.from(this.epochCounters.entries()) };
  }

  public hydrate(snapshot: { epochs?: NavigationEpoch[]; counters?: Array<[number, number]> }): void {
    this.activeEpochs.clear();
    this.epochCounters.clear();
    for (const [tabId, counter] of snapshot.counters ?? []) {
      if (Number.isInteger(tabId) && Number.isInteger(counter) && counter >= 0) {
        this.epochCounters.set(tabId, counter);
      }
    }
    for (const epoch of snapshot.epochs ?? []) {
      if (!epoch || !Number.isInteger(epoch.tabId) || !Number.isInteger(epoch.frameId)) continue;
      let frames = this.activeEpochs.get(epoch.tabId);
      if (!frames) {
        frames = new Map();
        this.activeEpochs.set(epoch.tabId, frames);
      }
      frames.set(epoch.frameId, { ...epoch });
      this.epochCounters.set(
        epoch.tabId,
        Math.max(this.epochCounters.get(epoch.tabId) ?? 0, epoch.navigationEpoch)
      );
    }
  }
}
