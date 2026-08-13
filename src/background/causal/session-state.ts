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

  persist(): Promise<void> {
    const snapshot: CausalSessionSnapshot = {
      version: 1,
      savedWallMs: Date.now(),
      navigation: this.registry.snapshot(),
      graphs: this.graphs.getAll(),
      belief: this.beliefs.snapshot(),
    };
    this.writeChain = this.writeChain.then(() =>
      this.backend.set({ [STORAGE_KEYS.CAUSAL_SESSION_STATE]: snapshot })
    );
    return this.writeChain;
  }
}
