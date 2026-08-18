/**
 * Protected Transaction Mode (Layer 2 of the protected-flow system).
 *
 * Layer 1 (src/shared/protected-flows.ts) forbids LEARNED rules from ever
 * targeting known identity/captcha/payment infrastructure. It cannot cover
 * what cannot be enumerated: bank-specific 3DS ACS hosts, custom enterprise
 * IdPs, future payment providers. Layer 2 closes that gap with USER INTENT:
 * when the human deliberately starts an authentication/payment/captcha
 * transaction, the tab enters a short-lived conservative mode —
 *
 *   - a high-priority, tab-scoped, SESSION-only allowAllRequests rule makes
 *     every blocking plane (static lists included) fail OPEN inside the tab's
 *     frame hierarchy, so unknown-but-flow-critical hosts (the 3DS bank the
 *     note's architecture calls out) inherit protection by descent;
 *   - the autonomy/survivor planes stand down on the tab (no experiments
 *     mid-transaction);
 *   - the mode ends on return-to-origin, tab close, or a short TTL, and normal
 *     protection resumes.
 *
 * Durability by construction: the allowance is a session rule (dies with the
 * browser session, can never become durable poison) and worker startup
 * physically removes every rule in the transaction band (fail closed to normal
 * protection — an in-flight flow re-begins on its next protected navigation).
 */

import { isProtectedFlowHost } from '../shared/protected-flows';
import { forensics } from './forensics/runtime-trace';

export const PROTECTED_TX_RULE_MIN = 5_000_000;
export const PROTECTED_TX_RULE_MAX = 5_009_999;
/** Above every static/learned priority in the system (USER_OVERRIDE is 1000). */
export const PROTECTED_TX_PRIORITY = 1_000_000;
/** Conservative-mode lifetime without activity; flow activity keeps it alive. */
export const PROTECTED_TX_TTL_MS = 4 * 60_000;

export type ProtectedTxReason = 'navigation' | 'intent' | 'popup-target';
export type ProtectedTxEndReason = 'flow-returned' | 'tab-closed' | 'ttl-expired' | 'startup-settle';

interface ActiveTransaction {
  ruleId: number;
  tabId: number;
  startedAtWallMs: number;
  lastTouchedWallMs: number;
  originHost?: string;
  reason: ProtectedTxReason;
}

export interface ProtectedTxBackend {
  getSessionRules(): Promise<chrome.declarativeNetRequest.Rule[]>;
  updateSessionRules(update: {
    addRules?: chrome.declarativeNetRequest.Rule[];
    removeRuleIds?: number[];
  }): Promise<void>;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostMatches(host: string, target: string): boolean {
  return host === target || host.endsWith(`.${target}`);
}

export class ProtectedTransactionManager {
  private readonly active = new Map<number, ActiveTransaction>();

  constructor(
    private readonly backend: ProtectedTxBackend,
    private readonly now: () => number = () => Date.now()
  ) {}

  public isActive(tabId: number): boolean {
    const tx = this.active.get(tabId);
    return tx !== undefined && this.now() - tx.lastTouchedWallMs <= PROTECTED_TX_TTL_MS;
  }

  public activeCount(): number {
    return this.active.size;
  }

  /**
   * Begin (or refresh) conservative mode for a tab. Idempotent per tab.
   * `originHost` is the origin the flow was launched FROM — a later main-frame
   * return to it ends the transaction immediately instead of waiting for TTL.
   */
  public async begin(tabId: number, reason: ProtectedTxReason, originHost?: string): Promise<boolean> {
    if (tabId < 0) return false;
    const existing = this.active.get(tabId);
    if (existing) {
      existing.lastTouchedWallMs = this.now();
      if (!existing.originHost && originHost) existing.originHost = originHost;
      return true;
    }
    const used = new Set([...this.active.values()].map((tx) => tx.ruleId));
    let ruleId = -1;
    for (let candidate = PROTECTED_TX_RULE_MIN; candidate <= PROTECTED_TX_RULE_MAX; candidate++) {
      if (!used.has(candidate)) {
        ruleId = candidate;
        break;
      }
    }
    if (ruleId === -1) return false; // 10k concurrent protected transactions — unreachable
    const rule: chrome.declarativeNetRequest.Rule = {
      id: ruleId,
      priority: PROTECTED_TX_PRIORITY,
      action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
      condition: {
        tabIds: [tabId],
        resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
      },
    };
    try {
      await this.backend.updateSessionRules({ addRules: [rule] });
    } catch {
      return false;
    }
    this.active.set(tabId, {
      ruleId,
      tabId,
      startedAtWallMs: this.now(),
      lastTouchedWallMs: this.now(),
      originHost,
      reason,
    });
    if (forensics.enabled) {
      forensics.event('PROTECTED_TX_BEGIN', { tabId, reason });
    }
    return true;
  }

  public async end(tabId: number, reason: ProtectedTxEndReason): Promise<boolean> {
    const tx = this.active.get(tabId);
    if (!tx) return false;
    this.active.delete(tabId);
    await this.backend.updateSessionRules({ removeRuleIds: [tx.ruleId] }).catch(() => undefined);
    if (forensics.enabled) {
      forensics.event('PROTECTED_TX_END', {
        tabId,
        reason,
        durationMs: Math.max(0, this.now() - tx.startedAtWallMs),
      });
    }
    return true;
  }

  /**
   * Begin trigger: a main-frame navigation STARTING toward a protected-flow
   * host (fires before the request, so the allowance pre-exists the flow's
   * first byte). Popup OAuth tabs and full-page redirect flows both arrive
   * here; `originHost` is the tab's pre-navigation origin for return detection.
   */
  public async onBeforeNavigate(tabId: number, frameId: number, url: string, originHost?: string): Promise<boolean> {
    if (frameId !== 0) return false;
    const host = hostOf(url);
    if (!host || !isProtectedFlowHost(host)) return false;
    return this.begin(tabId, 'navigation', originHost);
  }

  /**
   * Lifecycle on committed navigations. Any frame activity keeps the
   * transaction alive (3DS iframes, silent continuation frames). Main-frame
   * arrival at a NON-protected host does NOT end the transaction — enterprise
   * SSO chains and bank 3DS flows hop through unenumerable hosts; protection
   * inherits across the chain and the TTL is the bound. Only a return to the
   * recorded origin host ends it early.
   */
  public async onCommitted(tabId: number, frameId: number, url: string): Promise<void> {
    const tx = this.active.get(tabId);
    if (!tx) return;
    tx.lastTouchedWallMs = this.now();
    if (frameId !== 0) return;
    const host = hostOf(url);
    if (!host || isProtectedFlowHost(host)) return;
    if (tx.originHost && hostMatches(host, tx.originHost)) {
      await this.end(tabId, 'flow-returned');
    }
  }

  public async onTabRemoved(tabId: number): Promise<void> {
    await this.end(tabId, 'tab-closed');
  }

  /** TTL reaper — call from a periodic alarm and opportunistically on begin. */
  public async sweep(): Promise<number> {
    const now = this.now();
    let reaped = 0;
    for (const tx of [...this.active.values()]) {
      if (now - tx.lastTouchedWallMs > PROTECTED_TX_TTL_MS) {
        await this.end(tx.tabId, 'ttl-expired');
        reaped++;
      }
    }
    return reaped;
  }

  /**
   * Fail-closed startup settle: remove EVERY rule in the transaction band from
   * Chrome's physical session rules (ground truth — a rule whose map entry was
   * lost to worker suspension is still removed) and clear in-memory state. A
   * flow that was mid-transaction across the suspension re-begins on its next
   * protected navigation; until then the tab is simply normally protected.
   */
  public async settleOnWorkerStart(): Promise<number> {
    this.active.clear();
    const rules = await this.backend.getSessionRules().catch(() => [] as chrome.declarativeNetRequest.Rule[]);
    const strayIds = rules
      .map((rule) => rule.id)
      .filter((id) => id >= PROTECTED_TX_RULE_MIN && id <= PROTECTED_TX_RULE_MAX);
    if (strayIds.length > 0) {
      await this.backend.updateSessionRules({ removeRuleIds: strayIds }).catch(() => undefined);
    }
    if (strayIds.length > 0 && forensics.enabled) {
      forensics.event('PROTECTED_TX_STARTUP_SETTLE', { removed: strayIds.length });
    }
    return strayIds.length;
  }
}
