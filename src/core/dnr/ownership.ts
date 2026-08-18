/**
 * Learned-rule ownership + lifecycle metadata (Persistent Personal Learning, Phase A).
 *
 * Chrome owns the DNR rules; ADAPT owns the metadata. Two storage areas mirror the
 * two Chrome rule lifetimes:
 *   - chrome.storage.session — SESSION_* band rules (survive worker restarts, die
 *     with the browser session, exactly like Chrome session rules);
 *   - chrome.storage.local  — DYNAMIC_* band rules (durable personal memory,
 *     survives browser restarts, exactly like Chrome dynamic rules).
 *
 * Raw host/coarse-path values are stored locally because DNR reconstruction needs
 * them; they must NEVER be copied into exported forensic artifacts (hash-only there).
 */

import { STORAGE_KEYS } from '../../shared/constants';
import { IdBandType } from './ids';

export const SESSION_OWNERSHIP_KEY = 'adapt_dnr_ownership_session_v1';
export const DURABLE_OWNERSHIP_KEY = STORAGE_KEYS.DYNAMIC_RULE_ALLOCATIONS; // adapt_dnr_dynamic_v1

export type LearnedRuleLifecycle =
  | 'STAGED_SESSION'
  | 'HEALTHY_SESSION'
  | 'PROMOTION_ELIGIBLE'
  | 'PROMOTING'
  | 'PERSISTED_DYNAMIC'
  | 'DEMOTED'
  | 'REVOKED';

export type ScopeClass = 'session-experiment' | 'personal-blocklist';

export interface LearnedRuleOwnership {
  schemaVersion: 1;
  ruleId: number;
  band: IdBandType;
  ownerId: string; // txId for session rules; promotion id for dynamic rules
  lifecycle: LearnedRuleLifecycle;

  createdAt: number;
  updatedAt: number;
  lastMatchedAt?: number;

  learnedFromSiteKey?: string;
  requestFamilyKey: string; // `${host}${coarsePath}` — local-only raw identity
  requestDomainHash?: string; // salted hash for forensic correlation only
  scheme: string; // 'http:' | 'https:' — needed to reconstruct the exact urlFilter
  authority: string; // local-only host[:port] — needed to reconstruct the exact urlFilter
  host: string; // local-only raw hostname (no port) — identity, matching, requestDomains
  coarsePath: string; // local-only, first two path segments
  resourceTypes: string[];
  initiatorDomains?: string[]; // site scoping for personal rules
  /** Distinct site keys where this family was observed — drives safe globalization. */
  observedSiteKeys?: string[];
  hostWide: boolean; // Phase B: requestDomains-based rule vs narrow urlFilter
  /** Why host widening was refused (first-party, shared-infra) — evidence for audits. */
  widthRefusalReason?: string;
  scopeClass: ScopeClass;

  evidenceCount: number;
  healthyObservationCount: number;
  matchCount: number;
  healthFailureCount: number;
  rollbackCount: number;

  aiConfidenceAtDiscovery?: number;
  promotionReason?: string;
  revokedReason?: string;
}

interface OwnershipFileV1 {
  schemaVersion: 1;
  rules: Record<string, LearnedRuleOwnership>;
  /** ruleId → consecutive startup reconciles where an in-band rule had no ownership. */
  unknownSightings: Record<string, number>;
}

export interface OwnershipBackend {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove?: (key: string) => Promise<void>;
}

const EMPTY_FILE: OwnershipFileV1 = { schemaVersion: 1, rules: {}, unknownSightings: {} };

/**
 * One ownership area (session or durable). The in-memory map is the authoritative
 * cache after load; writes are debounced except flush() which critical transitions
 * await. No storage reads happen on the request hot path.
 */
export class OwnershipArea {
  private file: OwnershipFileV1 = { ...EMPTY_FILE, rules: {}, unknownSightings: {} };
  private loaded = false;
  private foreignSchema = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(
    private readonly backend: OwnershipBackend,
    private readonly storageKey: string
  ) {}

  public async load(): Promise<void> {
    const data = await this.backend.get(this.storageKey).catch(() => ({} as Record<string, unknown>));
    const raw = (data as Record<string, unknown>)[this.storageKey] as OwnershipFileV1 | undefined;
    if (raw && raw.schemaVersion === 1 && raw.rules && typeof raw.rules === 'object') {
      this.file = { schemaVersion: 1, rules: raw.rules, unknownSightings: raw.unknownSightings ?? {} };
    } else if (raw && typeof raw === 'object' && raw.rules && typeof raw.rules === 'object') {
      // A schema we cannot read (e.g. written by a newer build) is NOT an empty
      // area. Treating it as empty would make reconcile classify every physical
      // learned rule as an orphan and mass-remove the user's protections after
      // the grace window. Fail closed: keep nothing readable, but flag the area
      // so reconcile never garbage-collects on unreadable ground truth.
      this.foreignSchema = true;
    }
    this.loaded = true;
  }

  public isLoaded(): boolean {
    return this.loaded;
  }

  /** True when storage held a rules payload in a schema this build cannot read. */
  public hasForeignSchema(): boolean {
    return this.foreignSchema;
  }

  public get(ruleId: number): LearnedRuleOwnership | undefined {
    return this.file.rules[String(ruleId)];
  }

  public all(): LearnedRuleOwnership[] {
    return Object.values(this.file.rules);
  }

  public upsert(record: LearnedRuleOwnership): void {
    record.updatedAt = Date.now();
    this.file.rules[String(record.ruleId)] = record;
    this.scheduleFlush();
  }

  public patch(ruleId: number, patch: Partial<LearnedRuleOwnership>): void {
    const existing = this.file.rules[String(ruleId)];
    if (!existing) return;
    this.file.rules[String(ruleId)] = { ...existing, ...patch, updatedAt: Date.now() };
    this.scheduleFlush();
  }

  public delete(ruleId: number): void {
    delete this.file.rules[String(ruleId)];
    this.scheduleFlush();
  }

  public unknownSighting(ruleId: number): number {
    const key = String(ruleId);
    const seen = (this.file.unknownSightings[key] ?? 0) + 1;
    this.file.unknownSightings[key] = seen;
    this.scheduleFlush();
    return seen;
  }

  public clearUnknownSighting(ruleId: number): void {
    const key = String(ruleId);
    if (key in this.file.unknownSightings) {
      delete this.file.unknownSightings[key];
      this.scheduleFlush();
    }
  }

  public async wipe(): Promise<void> {
    this.file = { ...EMPTY_FILE, rules: {}, unknownSightings: {} };
    this.foreignSchema = false;
    this.dirty = true;
    await this.flush();
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), 400);
  }

  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty || !this.loaded) return;
    this.dirty = false;
    await this.backend.set({ [this.storageKey]: this.file }).catch(() => {
      this.dirty = true;
    });
  }
}

export class OwnershipStore {
  public readonly session: OwnershipArea;
  public readonly durable: OwnershipArea;

  constructor(sessionBackend: OwnershipBackend, durableBackend: OwnershipBackend) {
    this.session = new OwnershipArea(sessionBackend, SESSION_OWNERSHIP_KEY);
    this.durable = new OwnershipArea(durableBackend, DURABLE_OWNERSHIP_KEY);
  }

  public async load(): Promise<void> {
    await Promise.all([this.session.load(), this.durable.load()]);
  }

  /** True when either area holds a payload written in a schema this build cannot read. */
  public hasForeignSchema(): boolean {
    return this.session.hasForeignSchema() || this.durable.hasForeignSchema();
  }

  public async flush(): Promise<void> {
    await Promise.all([this.session.flush(), this.durable.flush()]);
  }
}

/** Parse a learned urlFilter of the form `|https://host/seg1/seg2*` into identity parts. */
export function parseLearnedUrlFilter(urlFilter: string): { scheme: string; authority: string; host: string; coarsePath: string } | undefined {
  const match = /^\|(https?):\/\/([^/*]+)([^*]*)/.exec(urlFilter);
  if (!match) return undefined;
  const authority = (match[2] ?? '').toLowerCase();
  return { scheme: `${match[1]}:`, authority, host: authority.split(':')[0] ?? authority, coarsePath: match[3] ?? '/' };
}
