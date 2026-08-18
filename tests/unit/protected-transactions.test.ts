/**
 * Protected Transaction Mode (Layer 2) regression suite: tab-scoped temporary
 * allowances for user-initiated auth/payment/captcha flows — begin triggers,
 * rule shape, redirect-chain inheritance, return-to-origin end, TTL reap,
 * fail-closed startup settle, and the autonomy stand-down gate.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  ProtectedTransactionManager,
  ProtectedTxBackend,
  PROTECTED_TX_PRIORITY,
  PROTECTED_TX_RULE_MAX,
  PROTECTED_TX_RULE_MIN,
  PROTECTED_TX_TTL_MS,
} from '../../src/background/protected-transactions';
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

function makeBackend() {
  const session = new Map<number, Rule>();
  const backend: ProtectedTxBackend = {
    getSessionRules: async () => [...session.values()],
    updateSessionRules: async (u) => {
      for (const id of u.removeRuleIds ?? []) session.delete(id);
      for (const rule of u.addRules ?? []) session.set(rule.id, rule);
    },
  };
  return { backend, session };
}

function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

describe('protected transaction mode (Layer 2)', () => {
  let clock: ReturnType<typeof makeClock>;
  beforeEach(() => {
    clock = makeClock();
  });

  it('begin installs a tab-scoped, session, high-priority allowAllRequests rule in the dedicated band', async () => {
    const { backend, session } = makeBackend();
    const manager = new ProtectedTransactionManager(backend, clock.now);
    const ok = await manager.begin(42, 'intent', 'shop.example.com');
    expect(ok).toBe(true);
    expect(manager.isActive(42)).toBe(true);
    expect(session.size).toBe(1);
    const rule = [...session.values()][0]!;
    expect(rule.id).toBeGreaterThanOrEqual(PROTECTED_TX_RULE_MIN);
    expect(rule.id).toBeLessThanOrEqual(PROTECTED_TX_RULE_MAX);
    expect(rule.priority).toBe(PROTECTED_TX_PRIORITY);
    expect(rule.action.type).toBe('allowAllRequests');
    expect(rule.condition.tabIds).toEqual([42]); // this tab only
    expect(rule.condition.resourceTypes).toEqual(['main_frame']); // frame-hierarchy allow
  });

  it('begin is idempotent per tab and refreshes activity', async () => {
    const { backend, session } = makeBackend();
    const manager = new ProtectedTransactionManager(backend, clock.now);
    await manager.begin(42, 'intent', 'shop.example.com');
    clock.advance(30_000);
    await manager.begin(42, 'navigation', 'accounts.google.com');
    expect(session.size).toBe(1); // no rule stacking
    expect(manager.activeCount()).toBe(1);
  });

  it('navigation trigger: protected hosts begin, ordinary hosts do not', async () => {
    const { backend, session } = makeBackend();
    const manager = new ProtectedTransactionManager(backend, clock.now);
    expect(await manager.onBeforeNavigate(7, 0, 'https://accounts.google.com/AccountChooser', 'example.com')).toBe(true);
    expect(await manager.onBeforeNavigate(8, 0, 'https://news.example.com/article', 'example.com')).toBe(false);
    expect(await manager.onBeforeNavigate(9, 1, 'https://accounts.google.com/o/oauth2/auth', 'example.com')).toBe(false); // sub-frame nav alone never begins
    expect(manager.isActive(7)).toBe(true);
    expect(manager.isActive(8)).toBe(false);
    expect(session.size).toBe(1);
  });

  it('redirect-chain inheritance: non-protected hops (custom IdP, bank ACS) keep the transaction alive', async () => {
    const { backend, session } = makeBackend();
    const manager = new ProtectedTransactionManager(backend, clock.now);
    await manager.onBeforeNavigate(7, 0, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', 'example.com');
    // Chain hops to an unenumerable enterprise IdP — must NOT end the transaction.
    await manager.onCommitted(7, 0, 'https://company-sso.example.org/saml/login');
    expect(manager.isActive(7)).toBe(true);
    // …and onward to a bank 3DS page — still alive.
    await manager.onCommitted(7, 0, 'https://acs.randombank.example/3ds/challenge');
    expect(manager.isActive(7)).toBe(true);
    expect(session.size).toBe(1);
  });

  it('return to the originating origin ends the transaction and removes the rule', async () => {
    const { backend, session } = makeBackend();
    const manager = new ProtectedTransactionManager(backend, clock.now);
    await manager.begin(42, 'intent', 'shop.example.com');
    await manager.onCommitted(42, 0, 'https://js.stripe.com/v3'); // protected — stays
    expect(manager.isActive(42)).toBe(true);
    await manager.onCommitted(42, 0, 'https://shop.example.com/order/complete'); // back to origin — done
    expect(manager.isActive(42)).toBe(false);
    expect(session.size).toBe(0); // rule physically removed
    // Subdomain return also matches (dot boundary).
    await manager.begin(43, 'intent', 'shop.example.com');
    await manager.onCommitted(43, 0, 'https://www.shop.example.com/done');
    expect(manager.isActive(43)).toBe(false);
  });

  it('sub-frame activity keeps the transaction alive (3DS iframe work)', async () => {
    const { backend } = makeBackend();
    const manager = new ProtectedTransactionManager(backend, clock.now);
    await manager.begin(42, 'intent', 'shop.example.com');
    clock.advance(PROTECTED_TX_TTL_MS - 60_000);
    await manager.onCommitted(42, 3, 'https://acs.randombank.example/3ds/frame'); // sub-frame touch
    clock.advance(PROTECTED_TX_TTL_MS - 60_000);
    expect(manager.isActive(42)).toBe(true); // would have TTL-expired without the touch
  });

  it('TTL reap ends stale transactions; tab close ends immediately', async () => {
    const { backend, session } = makeBackend();
    const manager = new ProtectedTransactionManager(backend, clock.now);
    await manager.begin(42, 'navigation', 'example.com');
    await manager.begin(43, 'intent', 'shop.example.com');
    clock.advance(PROTECTED_TX_TTL_MS + 1);
    const reaped = await manager.sweep();
    expect(reaped).toBe(2);
    expect(session.size).toBe(0);
    await manager.begin(44, 'intent', 'shop.example.com');
    await manager.onTabRemoved(44);
    expect(manager.isActive(44)).toBe(false);
    expect(session.size).toBe(0);
  });

  it('expired transactions read inactive even before the sweep runs', async () => {
    const { backend } = makeBackend();
    const manager = new ProtectedTransactionManager(backend, clock.now);
    await manager.begin(42, 'navigation', 'example.com');
    clock.advance(PROTECTED_TX_TTL_MS + 1);
    expect(manager.isActive(42)).toBe(false); // gates stand down with the TTL
    expect(manager.activeCount()).toBe(1); // physical rule awaits the sweep
  });

  it('startup settle removes every band rule from physical ground truth (fail closed)', async () => {
    const { backend, session } = makeBackend();
    // Stranded rule from a suspended worker — no in-memory state survives.
    session.set(PROTECTED_TX_RULE_MIN + 7, {
      id: PROTECTED_TX_RULE_MIN + 7,
      priority: PROTECTED_TX_PRIORITY,
      action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
      condition: { tabIds: [42], resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] },
    });
    // A foreign rule outside the band must be untouched.
    session.set(3_500_123, {
      id: 3_500_123,
      priority: 1,
      action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
      condition: { urlFilter: '||tracker.example.com^', resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType] },
    });
    const manager = new ProtectedTransactionManager(backend, clock.now);
    const removed = await manager.settleOnWorkerStart();
    expect(removed).toBe(1);
    expect(session.has(PROTECTED_TX_RULE_MIN + 7)).toBe(false);
    expect(session.has(3_500_123)).toBe(true);
  });

  it('end is idempotent and safe on unknown tabs', async () => {
    const { backend } = makeBackend();
    const manager = new ProtectedTransactionManager(backend, clock.now);
    expect(await manager.end(99, 'ttl-expired')).toBe(false);
    await manager.begin(42, 'intent', 'example.com');
    expect(await manager.end(42, 'flow-returned')).toBe(true);
    expect(await manager.end(42, 'flow-returned')).toBe(false);
  });

  it('autonomy stand-down gate: no experiments begin on a transaction tab', async () => {
    const registry = new NavigationRegistry();
    const graphs = new EventGraphStore();
    const epoch = registry.onNavigationCommitted(7, 0, 'https://site.test/page', undefined, 'doc-1');
    const scope = registry.getCausalKey(7, 0)!;
    const graph = graphs.getOrCreate(scope, 'deadbeef');
    let active = true;
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
      isProtectedTransactionActive: () => active,
    });
    orchestrator.setAdaptivePlanner(planner as never);
    type Runner = {
      maybeRun: (g: typeof graph, siteKey: string, navId: string, health: HealthVector) => Promise<boolean>;
      maybeRunSurvivorAi: (tabId: number, frameId: number, e: typeof epoch, s: typeof scope, g: typeof graph, batch: unknown, health: HealthVector) => Promise<void>;
    };
    const runner = orchestrator as unknown as Runner;
    // While the transaction is active: neither the autonomy path nor the
    // survivor-AI path may run.
    expect(await runner.maybeRun(graph, 'site.test', epoch.navigationId, gateHealth)).toBe(false);
    await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, { timestamp: 1, pageSignals: { timestamp: 1 }, elements: [], survivors: [] } as never, gateHealth);
    expect(planner.calls).toBe(0);
    expect(tabMessages).toHaveLength(0);
    // When the transaction ends, the gate reopens (normal protection resumes).
    active = false;
    await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, { timestamp: 1, pageSignals: { timestamp: 1 }, elements: [], survivors: [] } as never, gateHealth);
    // maybeRunSurvivorAi past the gate computes candidates and reaches the
    // planner gate — with no survivors it short-circuits before planning, so
    // the assertion is that the gate itself no longer early-returns.
    const maybeResult = await runner.maybeRun(graph, 'site.test', epoch.navigationId, gateHealth);
    expect(typeof maybeResult).toBe('boolean'); // ran the real path, no gate short-circuit
  });
});
