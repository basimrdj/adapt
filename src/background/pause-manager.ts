/**
 * Per-site pause (user allowlist) — the self-serve escape hatch.
 *
 * The popup writes the paused-host list to storage.local; this manager is the
 * single writer of the corresponding DNR allowance. Each paused host gets a
 * durable high-priority allowAllRequests rule keyed on the main frame
 * (requestDomains for real domains — subdomains inherit; a `||host` urlFilter
 * for IP literals, which requestDomains cannot express). allowAllRequests on a
 * main_frame cascades to the whole frame tree, so every blocking plane —
 * static lists included — fails open for visits to the host.
 *
 * Durable by intent: unlike Protected Transaction Mode (session rules, fail
 * closed on restart), a user pause must survive restarts, so these are DYNAMIC
 * rules. The ID band (5,010,000–5,019,999) sits outside the learned-rule
 * allocator (1M–5M) and the transaction band (5,000,000–5,009,999).
 *
 * Startup and every storage change reconcile Chrome ground truth against the
 * stored list — rules whose host was removed are deleted, hosts whose rule
 * vanished (quota eviction, manual clearing) are re-asserted.
 */

import { STORAGE_KEYS } from '../shared/constants';
import { hostIsPaused, sanitizePausedHosts } from '../shared/paused-hosts';
import { forensics } from './forensics/runtime-trace';

// Re-exported so existing background-side imports keep a single module surface.
export { hostIsPaused, sanitizePausedHosts };

export const PAUSE_RULE_MIN = 5_010_000;
export const PAUSE_RULE_MAX = 5_019_999;
/** Same fail-open priority as Protected Transaction Mode (USER_OVERRIDE is 1000). */
export const PAUSE_RULE_PRIORITY = 1_000_000;

export interface PauseRuleBackend {
  getDynamicRules(): Promise<chrome.declarativeNetRequest.Rule[]>;
  updateDynamicRules(update: {
    addRules?: chrome.declarativeNetRequest.Rule[];
    removeRuleIds?: number[];
  }): Promise<void>;
}

export interface PausedHostsStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
}

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

function ruleHost(rule: chrome.declarativeNetRequest.Rule): string | undefined {
  const domains = rule.condition.requestDomains;
  if (Array.isArray(domains) && domains.length === 1) return domains[0];
  const filter = rule.condition.urlFilter;
  if (typeof filter === 'string' && filter.startsWith('||')) return filter.slice(2);
  return undefined;
}

function buildPauseRule(id: number, host: string): chrome.declarativeNetRequest.Rule {
  const resourceTypes = ['main_frame' as chrome.declarativeNetRequest.ResourceType];
  return {
    id,
    priority: PAUSE_RULE_PRIORITY,
    action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
    condition: IPV4_PATTERN.test(host)
      ? { urlFilter: `||${host}`, resourceTypes }
      : { requestDomains: [host], resourceTypes },
  };
}

export class PauseManager {
  private pausedHosts: string[] = [];

  constructor(
    private readonly backend: PauseRuleBackend,
    private readonly storage: PausedHostsStorage
  ) {}

  public isPaused(host: string): boolean {
    if (host.length === 0) return false;
    return hostIsPaused(host, this.pausedHosts);
  }

  public pausedHostCount(): number {
    return this.pausedHosts.length;
  }

  /** Re-read the stored list and reconcile Chrome ground truth with it. */
  public async settleFromStorage(): Promise<{ added: number; removed: number }> {
    const data = await this.storage.get([STORAGE_KEYS.PAUSED_HOSTS]).catch(() => ({}) as Record<string, unknown>);
    return this.sync(sanitizePausedHosts((data as Record<string, unknown>)[STORAGE_KEYS.PAUSED_HOSTS]));
  }

  /** Diff the desired host set against the band's live rules; apply the delta. */
  public async sync(hosts: readonly string[]): Promise<{ added: number; removed: number }> {
    this.pausedHosts = [...hosts];
    const desired = new Set(hosts);
    const live = await this.backend.getDynamicRules();
    const bandRules = live.filter((rule) => rule.id >= PAUSE_RULE_MIN && rule.id <= PAUSE_RULE_MAX);

    const removeRuleIds: number[] = [];
    const liveHosts = new Set<string>();
    for (const rule of bandRules) {
      const host = ruleHost(rule);
      if (host === undefined || !desired.has(host) || liveHosts.has(host)) {
        // Orphan, stale, or duplicate band rule — remove.
        removeRuleIds.push(rule.id);
      } else {
        liveHosts.add(host);
      }
    }

    const usedIds = new Set(bandRules.map((rule) => rule.id).filter((id) => !removeRuleIds.includes(id)));
    const addRules: chrome.declarativeNetRequest.Rule[] = [];
    for (const host of desired) {
      if (liveHosts.has(host)) continue;
      const id = this.firstFreeId(usedIds);
      if (id === undefined) {
        // Band exhaustion is a forensics event, never a silent drop.
        forensics.event('PAUSE_BAND_EXHAUSTED', { host });
        break;
      }
      usedIds.add(id);
      addRules.push(buildPauseRule(id, host));
    }

    if (removeRuleIds.length > 0 || addRules.length > 0) {
      await this.backend.updateDynamicRules({ addRules, removeRuleIds });
    }
    if (addRules.length > 0 || removeRuleIds.length > 0) {
      forensics.event('PAUSE_SYNCED', { added: addRules.length, removed: removeRuleIds.length, total: desired.size });
    }
    return { added: addRules.length, removed: removeRuleIds.length };
  }

  private firstFreeId(usedIds: ReadonlySet<number>): number | undefined {
    for (let id = PAUSE_RULE_MIN; id <= PAUSE_RULE_MAX; id++) {
      if (!usedIds.has(id)) return id;
    }
    return undefined;
  }
}
