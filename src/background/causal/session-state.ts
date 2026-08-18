import { StorageBackend } from '../../core/recipes/store';
import { NavigationRegistry } from '../../core/navigation/registry';
import { STORAGE_KEYS } from '../../shared/constants';
import { EventGraph } from '../../shared/causal/events';
import { BetaBelief, WelfordAccumulator } from '../../shared/causal/belief';
import { NavigationEpoch } from '../../shared/types';
import { BeliefUpdater } from './belief-updater';
import { EventGraphStore } from './graph-store';

interface CausalSessionSnapshot {
  version: 1;
  savedWallMs: number;
  navigation: { epochs: NavigationEpoch[]; counters: Array<[number, number]> };
  graphs: EventGraph[];
  belief: {
    beliefs: Array<[string, BetaBelief]>;
    welfords: Array<[string, WelfordAccumulator]>;
  };
}

export class CausalSessionStateRepository {
  private writeChain: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive rejected storage writes — diagnostics for the durability trail. */
  private writeFailures = 0;

  constructor(
    private readonly backend: StorageBackend,
    private readonly registry: NavigationRegistry,
    private readonly graphs: EventGraphStore,
    private readonly beliefs: BeliefUpdater
  ) {}

  async restore(): Promise<boolean> {
    const data = await this.backend.get([STORAGE_KEYS.CAUSAL_SESSION_STATE]);
    const value = data[STORAGE_KEYS.CAUSAL_SESSION_STATE] as CausalSessionSnapshot | undefined;
    if (!value || value.version !== 1) return false;
    this.registry.hydrate(value.navigation ?? {});
    this.graphs.hydrate(value.graphs ?? []);
    this.beliefs.hydrate(value.belief ?? {});
    return true;
  }

  /** Number of storage writes that failed since worker boot (chain survived them). */
  public getWriteFailures(): number {
    return this.writeFailures;
  }

  persist(): Promise<void> {
    const snapshot: CausalSessionSnapshot = {
      version: 1,
      savedWallMs: Date.now(),
      navigation: this.registry.snapshot(),
      graphs: this.graphs.getAll(),
      belief: this.beliefs.snapshot(),
    };
    const write = this.writeChain.then(() =>
      this.backend.set({ [STORAGE_KEYS.CAUSAL_SESSION_STATE]: snapshot })
    );
    // A rejected write must not poison the chain: without this catch, one
    // transient storage error silently drops every subsequent snapshot for the
    // rest of the worker's lifetime. The caller's promise still reflects THIS
    // write's real outcome.
    this.writeChain = write.catch(() => {
      this.writeFailures++;
    });
    return write;
  }

  /**
   * Trailing-edge persist for hot per-request / per-observation-batch paths.
   * Learning boundaries (experiment commit/rollback, recipe writes) keep the
   * immediate persist(); routine event batches collapse to at most one storage
   * write per window instead of serializing the full session snapshot per
   * request, which delayed SAEI staging past the T04 timing budget.
   */
  persistSoon(windowMs = 150): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist().catch(() => undefined);
    }, windowMs);
  }
}
