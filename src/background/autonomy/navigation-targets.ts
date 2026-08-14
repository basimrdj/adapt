import { StorageBackend } from '../../core/recipes/store';
import { NavigationTargetObservation } from '../../shared/types';

export interface EphemeralNavigationTarget {
  ref: `navigation:n${number}`;
  tabId: number;
  sourceTabId: number;
  sourceFrameId: number;
  url: string;
  createdWallMs: number;
  destinationClass: NavigationTargetObservation['destinationClass'];
  closed: boolean;
  undoTabId?: number;
}

interface Snapshot {
  version: 1;
  targets: EphemeralNavigationTarget[];
}

export class EphemeralNavigationTargetRegistry {
  private readonly targets = new Map<string, EphemeralNavigationTarget>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly backend?: StorageBackend, private readonly storageKey = 'adapt_navigation_targets_v1') {}

  async restore(): Promise<void> {
    if (!this.backend) return;
    const data = await this.backend.get([this.storageKey]).catch(() => ({} as Record<string, unknown>));
    const snapshot = data[this.storageKey] as Snapshot | undefined;
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.targets)) return;
    for (const target of snapshot.targets) {
      if (target && typeof target.ref === 'string' && typeof target.url === 'string') {
        this.targets.set(target.ref, { ...target });
      }
    }
  }

  record(observation: NavigationTargetObservation, url: string): EphemeralNavigationTarget {
    const value: EphemeralNavigationTarget = {
      ref: observation.ref,
      tabId: observation.targetTabId,
      sourceTabId: observation.sourceTabId,
      sourceFrameId: observation.sourceFrameId,
      url,
      createdWallMs: observation.capturedWallMs,
      destinationClass: observation.destinationClass,
      closed: false,
    };
    this.targets.set(value.ref, value);
    void this.persist();
    return { ...value };
  }

  get(ref: string): EphemeralNavigationTarget | undefined {
    const value = this.targets.get(ref);
    return value ? { ...value } : undefined;
  }

  markClosed(ref: string, undoTabId?: number): void {
    const value = this.targets.get(ref);
    if (!value) return;
    value.closed = true;
    value.undoTabId = undoTabId;
    void this.persist();
  }

  clearTab(tabId: number): void {
    for (const [ref, target] of this.targets.entries()) {
      if (target.tabId === tabId || target.undoTabId === tabId) this.targets.delete(ref);
    }
    void this.persist();
  }

  snapshot(): EphemeralNavigationTarget[] {
    return [...this.targets.values()].map((target) => ({ ...target }));
  }

  private persist(): Promise<void> {
    if (!this.backend) return Promise.resolve();
    const snapshot: Snapshot = { version: 1, targets: this.snapshot() };
    this.writeChain = this.writeChain.then(() => this.backend!.set({ [this.storageKey]: snapshot }));
    return this.writeChain;
  }
}
