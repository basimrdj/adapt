/**
 * DEVELOPMENT-ONLY forensic instrumentation for the external adaptive-loop diagnosis
 * (artifacts/kimi-forensics). Not part of the product surface: records bounded counters,
 * gate reason codes, and salted-hash fingerprints into chrome.storage.session so a
 * reviewer can reconstruct how far real traffic travels through the adaptive loop.
 *
 * Privacy: no raw URLs, hostnames, selectors, or page text are persisted. All network
 * identity is reduced to a truncated SHA-256 keyed with a random salt. The salt lives
 * under a separate storage key that the export procedure does NOT include, so artifact
 * values cannot be dictionary-matched to known domains. The salt persists across
 * service-worker restarts within one browser session so family hashes stay comparable.
 *
 * Restart resilience: the artifact is restored and merged on every worker start, so a
 * mid-protocol service-worker termination does not erase earlier runs.
 *
 * Overhead: counter increments and ring-buffer appends; chrome.storage writes are
 * coalesced to at most one per second; the per-request DNR match probe runs only while
 * learned session rules exist.
 */

import { hashOrigin } from '../../shared/causal/events';
import { normalizeUrlForTelemetry } from '../../core/network/normalize-url';
import { registrableDomain } from '../../shared/resource-identity';

export const ADAPT_FORENSICS_ENABLED = true; // DEV-ONLY diagnostic build flag.

const STORAGE_KEY = 'adapt_kimi_forensics_v1';
const SALT_KEY = 'adapt_kimi_forensics_salt';
const MAX_EVENTS = 500;
const MAX_SNAPSHOTS = 60;
const MAX_FAMILIES = 300;
const MAX_RULES = 200;

export type AiSkipReason =
  | 'AI_PROVIDER_UNCONFIGURED'
  | 'AI_BUDGET_EXHAUSTED'
  | 'AI_NO_TRIGGER_NO_SURVIVOR_FEW_CANDIDATES'
  | 'AI_NO_TRIGGER_ORIGIN_ALREADY_AUDITED'
  | 'AI_SURVIVOR_WITHOUT_NETWORK_CANDIDATES'
  | 'AI_SKIP_KNOWN_FAMILY_COVERED'
  | 'AI_NO_CANDIDATES_AFTER_BUILD'
  | 'AI_NO_ACTION_SELECTED'
  | 'AI_PLANNER_FAILURE'
  | 'AI_POLICY_REJECTED'
  | 'AI_SITE_COOLDOWN'
  | 'AI_STALE_EPOCH_AFTER_PLANNER'
  | 'AI_AUTONOMY_EXPERIMENT_PENDING'
  | 'AI_CALL_IN_FLIGHT'
  | 'AI_SKIPPED_DETERMINISTIC_PATH_AVAILABLE';

export type RuleRemovalSource =
  | 'startup-reconcile'
  | 'executor-rollback'
  | 'engine-staging-failure'
  | 'adaptation-rollback'
  | 'tab-close-cleanup'
  | 'promotion'
  | 'revocation'
  | 'worker-restart-unverified'
  | 'protected-flow-purge'
  | 'user-clear'
  | 'unknown';

export interface ForensicEvent {
  t: number;
  kind: string;
  data?: Record<string, string | number | boolean | null>;
}

interface RuleRecord {
  learned: boolean;
  ownerClass: string;
  tabScoped: boolean;
  filterHash: string;
  resourceTypes: number;
  installedAt: number;
  removedAt?: number;
  removalSource?: string;
}

interface ForensicsState {
  version: 1;
  firstBootAt: number;
  counters: Record<string, number>;
  events: ForensicEvent[];
  rules: Record<string, RuleRecord>;
  sessionRuleSnapshots: Array<{ t: number; total: number; learned: number; ids: number[] }>;
  hostFamilies: Record<string, number>;
  hostPathFamilies: Record<string, number>;
}

function classifyOwner(txId: string): string {
  if (txId.startsWith('survivor_ai_')) return 'survivor-ai';
  if (txId.startsWith('recipe_')) return 'recipe';
  return 'adapt-tx';
}

function emptyState(): ForensicsState {
  return {
    version: 1,
    firstBootAt: Date.now(),
    counters: {},
    events: [],
    rules: {},
    sessionRuleSnapshots: [],
    hostFamilies: {},
    hostPathFamilies: {},
  };
}

class ForensicsRecorder {
  readonly enabled = ADAPT_FORENSICS_ENABLED;
  private salt = '';
  private state: ForensicsState = emptyState();
  private dirty = false;
  private flushScheduled = false;
  private writeChain: Promise<void>;
  private readonly learnedRuleIds = new Set<number>();
  private readonly eligiblePerScope = new Map<string, number>();

  constructor() {
    // All persistence chains behind the one-time restore so a fresh worker can never
    // overwrite the previous worker's artifact before merging it.
    this.writeChain = this.enabled ? this.restore() : Promise.resolve();
  }

  private async restore(): Promise<void> {
    try {
      const stored = await chrome.storage.session.get([STORAGE_KEY, SALT_KEY]);
      const prior = stored[STORAGE_KEY] as ForensicsState | undefined;
      let salt = stored[SALT_KEY] as string | undefined;
      if (typeof salt !== 'string' || salt.length < 8) {
        const random = new Uint8Array(8);
        crypto.getRandomValues(random);
        salt = [...random].map((b) => b.toString(16).padStart(2, '0')).join('');
        await chrome.storage.session.set({ [SALT_KEY]: salt }).catch(() => undefined);
      }
      this.salt = salt;
      if (prior && prior.version === 1) {
        // Merge prior state with anything recorded by this worker before restore
        // completed; current-boot records win on rule-id conflicts.
        const current = this.state;
        this.state = {
          version: 1,
          firstBootAt: prior.firstBootAt,
          counters: { ...prior.counters },
          events: [...prior.events, ...current.events].slice(-MAX_EVENTS),
          rules: { ...prior.rules, ...current.rules },
          sessionRuleSnapshots: [...prior.sessionRuleSnapshots, ...current.sessionRuleSnapshots].slice(-MAX_SNAPSHOTS),
          hostFamilies: { ...prior.hostFamilies },
          hostPathFamilies: { ...prior.hostPathFamilies },
        };
        for (const [counter, delta] of Object.entries(current.counters)) {
          this.state.counters[counter] = (this.state.counters[counter] ?? 0) + delta;
        }
        for (const [id, record] of Object.entries(this.state.rules)) {
          if (record.learned && record.removedAt === undefined) this.learnedRuleIds.add(Number(id));
        }
        this.dirty = true;
        // Write DIRECTLY here — flush() chains onto writeChain, which IS this restore
        // promise; chaining would deadlock every flush of a restarted worker forever.
        const snapshot = JSON.parse(JSON.stringify(this.state)) as ForensicsState;
        await chrome.storage.session.set({ [STORAGE_KEY]: snapshot }).catch(() => undefined);
        this.dirty = false;
      }
    } catch {
      if (!this.salt) {
        const random = new Uint8Array(8);
        crypto.getRandomValues(random);
        this.salt = [...random].map((b) => b.toString(16).padStart(2, '0')).join('');
      }
    }
  }

  /** Salted, truncated hash. The salt is stored separately and never exported. */
  hash(value: string): string {
    return hashOrigin(`${this.salt}|${value}`).slice(0, 16);
  }

  count(counter: string, delta = 1): void {
    if (!this.enabled) return;
    this.state.counters[counter] = (this.state.counters[counter] ?? 0) + delta;
    this.markDirty();
  }

  event(kind: string, data?: ForensicEvent['data']): void {
    if (!this.enabled) return;
    const entry: ForensicEvent = { t: Date.now(), kind, ...(data ? { data } : {}) };
    this.state.events.push(entry);
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    }
    this.markDirty();
  }

  aiSkip(reason: AiSkipReason, context?: ForensicEvent['data']): void {
    this.count(`aiSkip.${reason}`);
    this.event('AI_SKIP', { reason, ...context });
  }

  /** Family recurrence counters (section W). Salted host / host+path classes. */
  observeRequestFamily(rawUrl: string, resourceType: string): void {
    if (!this.enabled) return;
    const normalized = normalizeUrlForTelemetry(rawUrl);
    if (!normalized.hostname) return;
    const hostKey = this.hash(`${registrableDomain(normalized.hostname)}|${resourceType}`);
    const hostPathKey = this.hash(`${normalized.hostname}|${normalized.coarsePath}|${resourceType}`);
    const families = this.state.hostFamilies;
    families[hostKey] = (families[hostKey] ?? 0) + 1;
    if (Object.keys(families).length > MAX_FAMILIES) delete families[Object.keys(families)[0]!];
    const pathFamilies = this.state.hostPathFamilies;
    pathFamilies[hostPathKey] = (pathFamilies[hostPathKey] ?? 0) + 1;
    if (Object.keys(pathFamilies).length > MAX_FAMILIES) delete pathFamilies[Object.keys(pathFamilies)[0]!];
    this.markDirty();
  }

  /** Bounded per-scope eligibility counter so EXCLUDE_TOP_K can be attributed. */
  eligibilityOrdinal(scopeKey: string): number {
    const next = (this.eligiblePerScope.get(scopeKey) ?? 0) + 1;
    if (this.eligiblePerScope.size > 64) this.eligiblePerScope.clear();
    this.eligiblePerScope.set(scopeKey, next);
    return next;
  }

  /** Bounded per-request funnel record (cap 120) — salted hashes only, never raw URLs. */
  requestComplete(rawUrl: string, resourceType: string, thirdParty: boolean, excluded: string | null): void {
    if (!this.enabled) return;
    this.count('funnelEvents');
    if (this.count0('funnelEvents') > 120) return;
    const normalized = normalizeUrlForTelemetry(rawUrl);
    this.event('REQ_COMPLETE', {
      rt: resourceType,
      tp: thirdParty,
      ex: excluded ?? 'none',
      hh: this.hash(normalized.hostname),
      ph: this.hash(`${normalized.hostname}|${normalized.coarsePath}`),
    });
  }

  private count0(counter: string): number {
    return this.state.counters[counter] ?? 0;
  }

  markLearnedRules(ruleIds: readonly number[], meta: Array<{ urlFilter: string; resourceTypes: number; tabScoped: boolean }>, ownerId: string): void {
    if (!this.enabled) return;
    for (const [index, id] of ruleIds.entries()) {
      if (Object.keys(this.state.rules).length > MAX_RULES) break;
      const info = meta[index];
      this.learnedRuleIds.add(id);
      this.state.rules[String(id)] = {
        learned: true,
        ownerClass: classifyOwner(ownerId),
        tabScoped: info?.tabScoped ?? false,
        filterHash: this.hash(info?.urlFilter ?? ''),
        resourceTypes: info?.resourceTypes ?? 0,
        installedAt: Date.now(),
      };
    }
    this.markDirty();
  }

  unmarkLearnedRules(ruleIds: readonly number[], source: RuleRemovalSource): void {
    if (!this.enabled) return;
    for (const id of ruleIds) {
      this.learnedRuleIds.delete(id);
      const record = this.state.rules[String(id)];
      if (record && record.removedAt === undefined) {
        record.removedAt = Date.now();
        record.removalSource = source;
      }
    }
    this.markDirty();
  }

  hasLearnedRules(): boolean {
    return this.enabled && this.learnedRuleIds.size > 0;
  }

  learnedMatch(matchedRuleIds: readonly number[], rawUrl: string): void {
    if (!this.enabled) return;
    const learnedHits = matchedRuleIds.filter((id) => this.learnedRuleIds.has(id));
    if (learnedHits.length === 0) return;
    const normalized = normalizeUrlForTelemetry(rawUrl);
    this.count('learnedRuleMatches');
    for (const id of learnedHits) {
      this.event('LEARNED_RULE_MATCH', {
        ruleId: id,
        reqHostPathHash: this.hash(`${normalized.hostname}|${normalized.coarsePath}`),
      });
    }
  }

  /** Query Chrome itself for ground truth about installed session rules (section T). */
  async snapshotSessionRules(checkpoint: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      const ids = rules.map((rule) => rule.id);
      this.state.sessionRuleSnapshots.push({
        t: Date.now(),
        total: ids.length,
        learned: ids.filter((id) => this.learnedRuleIds.has(id)).length,
        ids: ids.slice(0, 100),
      });
      if (this.state.sessionRuleSnapshots.length > MAX_SNAPSHOTS) {
        this.state.sessionRuleSnapshots.splice(0, this.state.sessionRuleSnapshots.length - MAX_SNAPSHOTS);
      }
      this.event('SESSION_RULES_SNAPSHOT', { checkpoint, total: ids.length });
      await this.flush();
    } catch {
      this.event('SESSION_RULES_SNAPSHOT_FAILED', { checkpoint });
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setTimeout(() => {
        this.flushScheduled = false;
        if (this.dirty) void this.flush();
      }, 1000);
    }
  }

  flush(): Promise<void> {
    if (!this.enabled) return this.writeChain;
    this.dirty = false;
    const snapshot = JSON.parse(JSON.stringify(this.state)) as ForensicsState;
    this.writeChain = this.writeChain.then(() => {
      // Node-side verify scripts import this module for its in-memory counters;
      // there is no chrome global there and persistence is browser-only.
      if (typeof chrome === 'undefined' || !chrome.storage?.session) return undefined;
      return chrome.storage.session.set({ [STORAGE_KEY]: snapshot }).catch(() => undefined);
    });
    return this.writeChain;
  }
}

export const forensics = new ForensicsRecorder();
