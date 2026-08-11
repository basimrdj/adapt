import { NavigationEpoch } from '../../shared/types';
import { createNavigationEpoch } from './epoch';

export class NavigationRegistry {
  // Key: tabId -> Map<frameId, NavigationEpoch>
  private activeEpochs = new Map<number, Map<number, NavigationEpoch>>();

  public onNavigationCommitted(
    tabId: number,
    frameId: number,
    url: string,
    parentFrameId?: number
  ): NavigationEpoch {
    if (!this.activeEpochs.has(tabId)) {
      this.activeEpochs.set(tabId, new Map());
    }

    const frameMap = this.activeEpochs.get(tabId)!;
    // If main frame navigates, clear all subframe epochs for this tab
    if (frameId === 0) {
      frameMap.clear();
    }

    const epoch = createNavigationEpoch(tabId, frameId, url, parentFrameId);
    frameMap.set(frameId, epoch);
    return epoch;
  }

  public onHistoryStateUpdated(tabId: number, frameId: number, url: string): NavigationEpoch | null {
    const frameMap = this.activeEpochs.get(tabId);
    if (!frameMap) return null;

    const existing = frameMap.get(frameId);
    if (!existing) return null;

    // SPA Route Change - create new navigation epoch
    const updatedEpoch = createNavigationEpoch(tabId, frameId, url, existing.parentFrameId);
    frameMap.set(frameId, updatedEpoch);
    return updatedEpoch;
  }

  public getEpoch(tabId: number, frameId = 0): NavigationEpoch | undefined {
    return this.activeEpochs.get(tabId)?.get(frameId);
  }

  public isEpochValid(tabId: number, navigationId: string, frameId = 0): boolean {
    const epoch = this.getEpoch(tabId, frameId);
    return epoch !== undefined && epoch.navigationId === navigationId;
  }

  public onTabClosed(tabId: number): void {
    this.activeEpochs.delete(tabId);
  }

  public getActiveTabIds(): number[] {
    return Array.from(this.activeEpochs.keys());
  }
}
