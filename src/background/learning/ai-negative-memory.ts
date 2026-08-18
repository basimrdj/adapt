/**
 * AiNegativeMemoryStore — per-site AI failure budget with escalating cooldown.
 *
 * The survivor-AI gate budgets 2 planner calls per navigation, but without a
 * durable per-site memory a site where adaptation repeatedly fails keeps paying
 * those calls on every navigation forever — wasted latency, wasted tokens, and
 * repeated health-regression rollbacks on a page we cannot help. This store is
 * the deterministic "stop trying" memory: failures that say something about THE
 * SITE (the validator rejected the plan built from this page's evidence, no
 * stageable action was selected, the executor refused to stage here, or the
 * outcome verifier rolled the adaptation back) escalate a cooldown; a
 * verified-healthy adaptation resets it.
 *
 * What deliberately does NOT count: planner transport failures (HTTP/timeout —
 * that is OUR infrastructure or network, not evidence about the site) and
 * planner ABSTAIN decisions (a correct "nothing to do" is not a failure).
 *
 * House contract (same as stealth/cosmetic profile stores): storage.local,
 * idempotent load(), IMMEDIATE flush on every mutation (a debounced write can
 * die with the service worker), LRU-bounded, forensics hashes site keys.
 */

import { forensics } from '../forensics/runtime-trace';

const STORAGE_KEY = 'adapt_ai_negative_memory_v1';
const MAX_SITES = 200;
/** Consecutive-failure → cooldown escalation: 3 → 1h, 4 → 6h, 5+ → 24h. */
const COOLDOWN_LADDER_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const FAILURES_BEFORE_COOLDOWN = 3;
/** A site silent this long starts over — detectors change, give it a clean slate. */
const DECAY_MS = 7 * 24 * 60 * 60 * 1000;

export interface AiNegativeMemory {
  isCoolingDown(siteKey: string): boolean;
  noteFailure(siteKey: string, reason: string): void;
  noteSuccess(siteKey: string): void;
}

interface SiteMemory {
  consecutiveFailures: number;
  lastFailureAt: number;
  cooldownUntil: number;
  lastReason: string;
  successes: number;
}

interface MemoryShape {
  version: 1;
  sites: Record<string, SiteMemory>;
}

function validMemory(entry: unknown): entry is SiteMemory {
  const candidate = entry as Partial<SiteMemory> | undefined;
  return Boolean(candidate)
    && Number.isFinite(candidate?.consecutiveFailures)
    && Number.isFinite(candidate?.lastFailureAt)
    && Number.isFinite(candidate?.cooldownUntil)
    && typeof candidate?.lastReason === 'string'
    && Number.isFinite(candidate?.successes);
}

export class AiNegativeMemoryStore implements AiNegativeMemory {
  private sites = new Map<string, SiteMemory>();
  private loaded = false;

  public async load(): Promise<void> {
    // Idempotent: mutations flush immediately, so a second load could only
    // clobber fresher in-memory state with a stale snapshot.
    if (this.loaded) return;
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const shape = stored[STORAGE_KEY] as MemoryShape | undefined;
      if (shape?.version === 1 && shape.sites && typeof shape.sites === 'object') {
        for (const [site, memory] of Object.entries(shape.sites)) {
          if (validMemory(memory)) this.sites.set(site, { ...memory });
        }
      }
    } catch {
      // Corrupt/absent store → start empty (fail-open = pre-memory behavior).
    } finally {
      this.loaded = true;
    }
  }

  /** True while the site's cooldown is active. Read-only; never writes. */
  public isCoolingDown(siteKey: string): boolean {
    if (!siteKey) return false;
    const memory = this.sites.get(siteKey);
    return memory !== undefined && memory.cooldownUntil > Date.now();
  }

  /**
   * Record site-signaling AI failure evidence (policy-rejected / no-action /
   * stage-rejected / outcome-rollback). Escalates the cooldown ladder and
   * flushes immediately — crash-safe like every other learning store.
   */
  public noteFailure(siteKey: string, reason: string): void {
    if (!this.loaded || !siteKey) return;
    const now = Date.now();
    const existing = this.sites.get(siteKey);
    const decayed = existing !== undefined && now - existing.lastFailureAt > DECAY_MS;
    const consecutiveFailures = existing && !decayed ? existing.consecutiveFailures + 1 : 1;
    const cooldownMs = consecutiveFailures < FAILURES_BEFORE_COOLDOWN
      ? 0
      : COOLDOWN_LADDER_MS[Math.min(consecutiveFailures - FAILURES_BEFORE_COOLDOWN, COOLDOWN_LADDER_MS.length - 1)]!;
    const memory: SiteMemory = {
      consecutiveFailures,
      lastFailureAt: now,
      cooldownUntil: now + cooldownMs,
      lastReason: reason.slice(0, 48),
      successes: existing?.successes ?? 0,
    };
    this.sites.set(siteKey, memory);
    this.enforceCapacity();
    void this.flush();
    forensics.count('aiNegativeMemoryFailures');
    forensics.event('AI_NEGATIVE_MEMORY_FAILURE', {
      siteHash: forensics.hash(siteKey),
      consecutiveFailures,
      cooldownMinutes: Math.round(cooldownMs / 60000),
      reason: memory.lastReason,
    });
  }

  /** A verified-healthy adaptation on this site wipes the failure streak. */
  public noteSuccess(siteKey: string): void {
    if (!this.loaded || !siteKey) return;
    const existing = this.sites.get(siteKey);
    if (!existing) return; // no failure memory → nothing to reset; keep the map small
    if (existing.consecutiveFailures === 0 && existing.cooldownUntil <= Date.now()) return;
    this.sites.delete(siteKey);
    void this.flush();
    forensics.event('AI_NEGATIVE_MEMORY_RESET', {
      siteHash: forensics.hash(siteKey),
      clearedFailures: existing.consecutiveFailures,
    });
  }

  public count(): number {
    return this.sites.size;
  }

  public async clearAll(): Promise<void> {
    this.sites.clear();
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
    } catch {
      /* noop */
    }
  }

  private enforceCapacity(): void {
    if (this.sites.size <= MAX_SITES) return;
    const ordered = [...this.sites.entries()].sort((a, b) => a[1].lastFailureAt - b[1].lastFailureAt);
    for (const [key] of ordered.slice(0, this.sites.size - MAX_SITES)) {
      this.sites.delete(key);
    }
  }

  public async flush(): Promise<void> {
    if (!this.loaded) return;
    const shape: MemoryShape = {
      version: 1,
      sites: Object.fromEntries([...this.sites.entries()].map(([key, memory]) => [key, { ...memory }])),
    };
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: shape });
    } catch {
      /* storage quota pressure — LRU keeps this bounded */
    }
  }
}
