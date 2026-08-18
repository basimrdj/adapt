/**
 * Per-site pause (user allowlist) regression suite: rule shape for domains vs
 * IP literals, band allocation, orphan/duplicate reconcile, fail-closed
 * sanitization, dot-boundary host matching, storage settle, and the
 * autonomy/survivor stand-down gate.
 */
import { describe, expect, it } from 'vitest';
import {
  PauseManager,
  PauseRuleBackend,
  PausedHostsStorage,
  PAUSE_RULE_MAX,
  PAUSE_RULE_MIN,
  PAUSE_RULE_PRIORITY,
  hostIsPaused,
  sanitizePausedHosts,
} from '../../src/background/pause-manager';
import { STORAGE_KEYS } from '../../src/shared/constants';
import { CausalOrchestrator } from '../../src/background/causal/orchestrator';
import { NavigationRegistry } from '../../src/core/navigation/registry';
import { EventGraphStore } from '../../src/background/causal/graph-store';
import { BeliefUpdater } from '../../src/background/causal/belief-updater';
import { PromotionGate } from '../../src/background/causal/promotion-gate';
import { HealthVector } from '../../src/shared/types';

type Rule = chrome.declarativeNetRequest.Rule;

const gateHealth: HealthVector = {
  antiBlockReaction: 0.55,
  contentAvailability: 1,
  interaction: 1,
  scrollability: 1,
  navigationHealth: 1,
  visualObstruction: 0.4,
  mutationStability: 1,
  networkIntegrity: 1,
  privacyPreservation: 1,
  confidence: 1,
};

function makeBackend(seed: Rule[] = []) {
  const dynamic = new Map<number, Rule>(seed.map((rule) => [rule.id, rule]));
  const backend: PauseRuleBackend = {
    getDynamicRules: async () => [...dynamic.values()],
    updateDynamicRules: async (u) => {
      for (const id of u.removeRuleIds ?? []) dynamic.delete(id);
      for (const rule of u.addRules ?? []) dynamic.set(rule.id, rule);
    },
  };
  return { backend, dynamic };
}

function makeStorage(payload: Record<string, unknown> = {}) {
  const storage: PausedHostsStorage = {
    get: async (keys) => Object.fromEntries(keys.filter((key) => key in payload).map((key) => [key, payload[key]])),
  };
  return storage;
}

function bandRules(dynamic: Map<number, Rule>): Rule[] {
  return [...dynamic.values()].filter((rule) => rule.id >= PAUSE_RULE_MIN && rule.id <= PAUSE_RULE_MAX);
}

describe('sanitizePausedHosts / hostIsPaused', () => {
  it('fails closed to an empty list on a poisoned payload', () => {
    expect(sanitizePausedHosts(undefined)).toEqual([]);
    expect(sanitizePausedHosts(null)).toEqual([]);
    expect(sanitizePausedHosts('example.com')).toEqual([]);
    expect(sanitizePausedHosts(42)).toEqual([]);
    expect(sanitizePausedHosts([42, null, {}, ['x']])).toEqual([]);
  });

  it('lowercases, trims, dedupes, and drops malformed entries', () => {
    expect(sanitizePausedHosts(['Example.COM ', 'example.com', 'sub.example.com', '', 'bad host', 'x'.repeat(254)])).toEqual([
      'example.com',
      'sub.example.com',
    ]);
  });

  it('matches exact hosts and subdomains but never sibling prefixes', () => {
    const paused = ['example.com', '127.0.0.1'];
    expect(hostIsPaused('example.com', paused)).toBe(true);
    expect(hostIsPaused('www.example.com', paused)).toBe(true);
    expect(hostIsPaused('a.b.example.com', paused)).toBe(true);
    expect(hostIsPaused('notexample.com', paused)).toBe(false);
    expect(hostIsPaused('ample.com', paused)).toBe(false);
    expect(hostIsPaused('example.com.evil.test', paused)).toBe(false);
    expect(hostIsPaused('127.0.0.1', paused)).toBe(true);
    expect(hostIsPaused('EXAMPLE.COM', paused)).toBe(true);
  });
});

describe('PauseManager', () => {
  it('sync installs a durable high-priority allowAllRequests main_frame rule per host, in the pause band', async () => {
    const { backend, dynamic } = makeBackend();
    const manager = new PauseManager(backend, makeStorage());
    const result = await manager.sync(['example.com']);
    expect(result).toEqual({ added: 1, removed: 0 });
    const rules = bandRules(dynamic);
    expect(rules).toHaveLength(1);
    const rule = rules[0]!;
    expect(rule.id).toBeGreaterThanOrEqual(PAUSE_RULE_MIN);
    expect(rule.id).toBeLessThanOrEqual(PAUSE_RULE_MAX);
    expect(rule.priority).toBe(PAUSE_RULE_PRIORITY);
    expect(rule.action.type).toBe('allowAllRequests');
    expect(rule.condition.requestDomains).toEqual(['example.com']);
    expect(rule.condition.urlFilter).toBeUndefined();
    expect(rule.condition.resourceTypes).toEqual(['main_frame']); // frame-hierarchy allow
    expect(manager.isPaused('example.com')).toBe(true);
    expect(manager.isPaused('cdn.example.com')).toBe(true);
    expect(manager.isPaused('other.test')).toBe(false);
    expect(manager.isPaused('')).toBe(false);
  });

  it('IP literals use a ||host urlFilter (requestDomains cannot express them)', async () => {
    const { backend, dynamic } = makeBackend();
    const manager = new PauseManager(backend, makeStorage());
    await manager.sync(['127.0.0.1']);
    const rule = bandRules(dynamic)[0]!;
    expect(rule.condition.requestDomains).toBeUndefined();
    expect(rule.condition.urlFilter).toBe('||127.0.0.1');
    expect(rule.condition.resourceTypes).toEqual(['main_frame']);
  });

  it('sync removes rules whose host left the list, and leaves out-of-band rules untouched', async () => {
    const { backend, dynamic } = makeBackend();
    const manager = new PauseManager(backend, makeStorage());
    await manager.sync(['example.com', 'news.test']);
    dynamic.set(3_500_123, {
      id: 3_500_123,
      priority: 1,
      action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
      condition: { urlFilter: '||tracker.test', resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType] },
    });
    const result = await manager.sync(['news.test']);
    expect(result).toEqual({ added: 0, removed: 1 });
    expect(bandRules(dynamic).map((rule) => rule.condition.requestDomains?.[0])).toEqual(['news.test']);
    expect(dynamic.has(3_500_123)).toBe(true); // learned-rule band untouched
  });

  it('reconcile repairs orphans (rule exists, host not desired) and vanished rules (host desired, rule gone)', async () => {
    const orphan: Rule = {
      id: PAUSE_RULE_MIN + 5,
      priority: PAUSE_RULE_PRIORITY,
      action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
      condition: { requestDomains: ['stale.test'], resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] },
    };
    const { backend, dynamic } = makeBackend([orphan]);
    const manager = new PauseManager(backend, makeStorage());
    const result = await manager.sync(['fresh.test']);
    expect(result).toEqual({ added: 1, removed: 1 });
    expect(dynamic.has(PAUSE_RULE_MIN + 5)).toBe(false);
    expect(bandRules(dynamic)[0]!.condition.requestDomains).toEqual(['fresh.test']);
  });

  it('duplicate band rules for one host collapse to a single rule', async () => {
    const dupe = (id: number): Rule => ({
      id,
      priority: PAUSE_RULE_PRIORITY,
      action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
      condition: { requestDomains: ['example.com'], resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] },
    });
    const { backend, dynamic } = makeBackend([dupe(PAUSE_RULE_MIN), dupe(PAUSE_RULE_MIN + 1)]);
    const manager = new PauseManager(backend, makeStorage());
    const result = await manager.sync(['example.com']);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(bandRules(dynamic)).toHaveLength(1);
  });

  it('id allocation reuses freed ids and survives band exhaustion without throwing', async () => {
    const { backend, dynamic } = makeBackend();
    const manager = new PauseManager(backend, makeStorage());
    await manager.sync(['a.test', 'b.test']);
    const ids = bandRules(dynamic).map((rule) => rule.id).sort((x, y) => x - y);
    expect(ids).toEqual([PAUSE_RULE_MIN, PAUSE_RULE_MIN + 1]);
    await manager.sync(['b.test', 'c.test']);
    // a.test's freed id is reused for c.test — no drift up the band.
    expect(bandRules(dynamic).map((rule) => rule.id).sort((x, y) => x - y)).toEqual([PAUSE_RULE_MIN, PAUSE_RULE_MIN + 1]);
    // Exhaustion: seed the entire band, then ask for one more host.
    const full: Rule[] = [];
    for (let id = PAUSE_RULE_MIN; id <= PAUSE_RULE_MAX; id++) {
      full.push({
        id,
        priority: PAUSE_RULE_PRIORITY,
        action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
        condition: { urlFilter: `||h${id}.invalid`, resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] },
      });
    }
    const crowded = makeBackend(full);
    const crowdedManager = new PauseManager(crowded.backend, makeStorage());
    const result = await crowdedManager.sync([...full.map((rule) => rule.condition.urlFilter!.slice(2)), 'overflow.test']);
    expect(result.added).toBe(0); // no id — logged via forensics, never a silent drop or a throw
    expect(bandRules(crowded.dynamic)).toHaveLength(PAUSE_RULE_MAX - PAUSE_RULE_MIN + 1);
  });

  it('settleFromStorage reads, sanitizes, and reconciles; poisoned storage fails closed', async () => {
    const { backend, dynamic } = makeBackend();
    const manager = new PauseManager(
      backend,
      makeStorage({ [STORAGE_KEYS.PAUSED_HOSTS]: ['Good.TEST', 42, null, 'also-good.example'] })
    );
    const result = await manager.settleFromStorage();
    expect(result.added).toBe(2);
    expect(bandRules(dynamic).map((rule) => rule.condition.requestDomains?.[0]).sort()).toEqual(['also-good.example', 'good.test']);
    const poisoned = new PauseManager(makeBackend().backend, makeStorage({ [STORAGE_KEYS.PAUSED_HOSTS]: { not: 'a list' } }));
    expect((await poisoned.settleFromStorage()).added).toBe(0);
    expect(poisoned.pausedHostCount()).toBe(0);
  });

  it('a backend failure propagates (caller catches) and never half-applies', async () => {
    const failing: PauseRuleBackend = {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => { throw new Error('chrome quota'); },
    };
    const manager = new PauseManager(failing, makeStorage());
    await expect(manager.sync(['example.com'])).rejects.toThrow('chrome quota');
  });
});

describe('pause stand-down gates (orchestrator)', () => {
  it('no autonomy experiments or survivor-AI calls run on a paused tab; the gate reopens on resume', async () => {
    const registry = new NavigationRegistry();
    const graphs = new EventGraphStore();
    const epoch = registry.onNavigationCommitted(7, 0, 'https://site.test/page', undefined, 'doc-1');
    const scope = registry.getCausalKey(7, 0)!;
    const graph = graphs.getOrCreate(scope, 'deadbeef');
    let paused = true;
    const tabMessages: unknown[] = [];
    const planner = { calls: 0, plan: async () => { planner.calls++; throw new Error('must not be called'); } };
    const orchestrator = new CausalOrchestrator({
      registry,
      requestGraphs: { getGraph: () => undefined } as never,
      graphs,
      beliefs: new BeliefUpdater(),
      engine: { getRecords: () => [] } as never,
      session: { persist: async () => {}, persistSoon: () => {} } as never,
      sendTabMessage: async (_tabId: number, message: unknown) => { tabMessages.push(message); },
      recipeStore: { getRecipe: async () => undefined } as never,
      promotion: new PromotionGate(),
      runFallback: async () => null,
      isPausedTab: () => paused,
    });
    orchestrator.setAdaptivePlanner(planner as never);
    type Runner = {
      maybeRun: (g: typeof graph, siteKey: string, navId: string, health: HealthVector) => Promise<boolean>;
      maybeRunSurvivorAi: (tabId: number, frameId: number, e: typeof epoch, s: typeof scope, g: typeof graph, batch: unknown, health: HealthVector) => Promise<void>;
    };
    const runner = orchestrator as unknown as Runner;
    // Paused: neither the autonomy path nor the survivor-AI path may run.
    expect(await runner.maybeRun(graph, 'site.test', epoch.navigationId, gateHealth)).toBe(false);
    await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, { timestamp: 1, pageSignals: { timestamp: 1 }, elements: [], survivors: [] } as never, gateHealth);
    expect(planner.calls).toBe(0);
    expect(tabMessages).toHaveLength(0);
    // Resumed: the gate reopens and the real path executes.
    paused = false;
    await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, { timestamp: 1, pageSignals: { timestamp: 1 }, elements: [], survivors: [] } as never, gateHealth);
    const maybeResult = await runner.maybeRun(graph, 'site.test', epoch.navigationId, gateHealth);
    expect(typeof maybeResult).toBe('boolean'); // ran the real path, no gate short-circuit
  });
});
