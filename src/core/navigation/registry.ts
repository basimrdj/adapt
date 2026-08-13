import { CausalDocumentKey } from '../../shared/causal/events';
import { NavigationEpoch } from '../../shared/types';
import { createNavigationEpoch } from './epoch';

export class NavigationRegistry {
  // Key: tabId -> Map<frameId, NavigationEpoch>
  private activeEpochs = new Map<number, Map<number, NavigationEpoch>>();
  /** Per-tab monotonic navigationEpoch counter. Starts at 1. Never uses processId. */
  private epochCounters = new Map<number, number>();

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
    // If main frame navigates, clear all subframe epochs for this tab
    if (frameId === 0) {
      frameMap.clear();
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
