import { describe, expect, it } from 'vitest';
import { BeliefUpdater } from '../../src/background/causal/belief-updater';
import { EpochRouter } from '../../src/background/causal/epoch-router';
import { EventGraphStore } from '../../src/background/causal/graph-store';
import { CausalSessionStateRepository } from '../../src/background/causal/session-state';
import { NavigationRegistry } from '../../src/core/navigation/registry';
import { StorageBackend } from '../../src/core/recipes/store';
import { hashOrigin } from '../../src/shared/causal/events';

class MemorySessionStorage implements StorageBackend {
  data: Record<string, unknown> = {};
  async get(keys: string[]) {
    return Object.fromEntries(keys.filter((key) => key in this.data).map((key) => [key, this.data[key]]));
  }
  async set(items: Record<string, unknown>) { Object.assign(this.data, structuredClone(items)); }
  async remove(keys: string[]) { for (const key of keys) delete this.data[key]; }
}

describe('CausalSessionStateRepository', () => {
  it('restores epochs, counters, graphs, and beliefs across a worker restart', async () => {
    const backend = new MemorySessionStorage();
    const registry1 = new NavigationRegistry();
    const epoch = registry1.onNavigationCommitted(7, 0, 'https://news.example/a', undefined, 'doc-a');
    const graphs1 = new EventGraphStore(new EpochRouter(registry1));
    const graph = graphs1.getOrCreate(registry1.getCausalKey(7, 0)!, hashOrigin(epoch.origin));
    graph.hypotheses.push({
      id: 'hypothesis:h1', causeRefs: [], outcome: 'PAGE_BREAKAGE', mechanismClass: 'UNKNOWN',
      prior: 0.3, posterior: 0.3, confoundingRisk: 'LOW', status: 'CANDIDATE',
      createdFrom: [], updatedByExperiments: [],
    });
    const beliefs1 = new BeliefUpdater();
    beliefs1.hydrate({ beliefs: [['hypothesis:h1', { alpha: 4, beta: 1 }]], welfords: [] });
    await new CausalSessionStateRepository(backend, registry1, graphs1, beliefs1).persist();

    const registry2 = new NavigationRegistry();
    const graphs2 = new EventGraphStore(new EpochRouter(registry2));
    const beliefs2 = new BeliefUpdater();
    const restored = await new CausalSessionStateRepository(backend, registry2, graphs2, beliefs2).restore();

    expect(restored).toBe(true);
    expect(registry2.getCausalKey(7, 0)).toEqual(registry1.getCausalKey(7, 0));
    expect(graphs2.getAll()).toHaveLength(1);
    expect(graphs2.getAll()[0]?.hypotheses[0]?.id).toBe('hypothesis:h1');
    expect(beliefs2.getBelief('hypothesis:h1')).toEqual({ alpha: 4, beta: 1 });
    const next = registry2.onHistoryStateUpdated(7, 0, 'https://news.example/b');
    expect(next?.navigationEpoch).toBe(epoch.navigationEpoch + 1);
  });
});
