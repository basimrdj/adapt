import { registrableDomain } from '../../shared/resource-identity';
import { forensics } from '../forensics/runtime-trace';

/**
 * Cosmetic learning profiles (Phase E): per-site persistence for DOM hides that
 * were verified healthy by the outcome pipeline. The static cosmetic plane only
 * knows list-maintained selectors; this store is the learned complement for
 * first-party sponsored surfaces the lists miss.
 *
 * Flow: the page captures a conservative stable selector at hide-apply time and
 * acks it via DOM_ACTION_RESULT (noteAppliedHides, pending). The causal outcome
 * verifiers then either confirm (healthy → persist, replay from now on) or
 * discard (rolled back → never persisted). Replay runs as pre-paint CSS injected
 * at navigation commit; the page-side guard reports breakage/misses and repeat
 * failures drop the rule.
 *
 * Persistence lessons baked in (see stealth-profiles): storage.local, idempotent
 * load, IMMEDIATE flush on every mutation — a debounced write can die with the
 * service worker and silently lose the learning.
 */

const STORAGE_KEY = 'adapt_cosmetic_profiles_v1';
const MAX_SITES = 200;
const MAX_HIDES_PER_SITE = 8;
const MAX_PENDING = 120;
const PENDING_TTL_MS = 90_000;
const DROP_AFTER_FAILURES = 3;
const DROP_AFTER_CONSECUTIVE_MISSES = 5;

/** Stable-selector grammar: `#id` or `tag.class[.class]` — mirrors the page-side capture. */
const SELECTOR_PATTERN = /^(#[A-Za-z][A-Za-z0-9_-]{2,63}|[a-z][a-z0-9]{0,15}(\.[A-Za-z][A-Za-z0-9_-]{2,63}){1,2})$/;

export interface CosmeticHide {
  selector: string;
  learnedAt: number;
  lastSeenAt: number;
  /** Replays that matched and left the page healthy. */
  passes: number;
  /** Replays followed by a content-collapse report. */
  failures: number;
  /** Consecutive visits where the selector matched nothing (markup drift). */
  consecutiveMisses: number;
}

interface SiteCosmetics {
  hides: CosmeticHide[];
  updatedAt: number;
}

interface ProfileShape {
  version: 1;
  sites: Record<string, SiteCosmetics>;
}

interface PendingHides {
  siteKey: string;
  selectors: string[];
  at: number;
}

export class CosmeticProfileStore {
  private sites = new Map<string, SiteCosmetics>();
  private pending = new Map<string, PendingHides>();
  private loaded = false;

  public async load(): Promise<void> {
    // Idempotent: learns flush immediately, so a second load could only clobber
    // fresher in-memory state with a stale storage snapshot.
    if (this.loaded) return;
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const shape = stored[STORAGE_KEY] as ProfileShape | undefined;
      if (shape?.version === 1 && shape.sites && typeof shape.sites === 'object') {
        for (const [siteKey, site] of Object.entries(shape.sites)) {
          if (!site || !Array.isArray(site.hides)) continue;
          const hides = site.hides
            .filter((hide) => hide && SELECTOR_PATTERN.test(hide.selector))
            .slice(0, MAX_HIDES_PER_SITE);
          if (hides.length === 0) continue;
          this.sites.set(siteKey, { hides, updatedAt: site.updatedAt ?? Date.now() });
        }
      }
    } catch {
      // Corrupt/absent store → start empty; learning repopulates.
    } finally {
      this.loaded = true;
    }
  }

  public siteKeyOf(url: string): string {
    try {
      return registrableDomain(new URL(url).hostname.toLowerCase());
    } catch {
      return '';
    }
  }

  /** Selectors to replay for a page url (empty when nothing learned). */
  public replayFor(url: string): string[] {
    const key = this.siteKeyOf(url);
    if (!key) return [];
    const site = this.sites.get(key);
    if (!site) return [];
    site.updatedAt = Date.now();
    return site.hides.map((hide) => hide.selector);
  }

  /** Page acked a hide-type DOM action: hold its selectors until the outcome verdict. */
  public noteAppliedHides(txId: string | undefined, pageUrl: string, selectors: string[]): void {
    if (!this.loaded || !txId || selectors.length === 0) return;
    const siteKey = this.siteKeyOf(pageUrl);
    if (!siteKey) return;
    this.sweepPending();
    const valid = selectors.filter((selector) => SELECTOR_PATTERN.test(selector)).slice(0, 4);
    if (valid.length === 0) return;
    const existing = this.pending.get(txId);
    this.pending.set(txId, {
      siteKey,
      selectors: [...new Set([...(existing?.selectors ?? []), ...valid])].slice(0, 4),
      at: Date.now(),
    });
    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }

  /** Outcome verifier marked the transaction healthy — the hides are learned. */
  public confirmHides(txId: string): number {
    const pending = this.pending.get(txId);
    if (!pending) return 0;
    this.pending.delete(txId);
    const site = this.sites.get(pending.siteKey) ?? { hides: [], updatedAt: Date.now() };
    const known = new Set(site.hides.map((hide) => hide.selector));
    let learned = 0;
    for (const selector of pending.selectors) {
      if (known.has(selector) || site.hides.length >= MAX_HIDES_PER_SITE) continue;
      site.hides.push({
        selector,
        learnedAt: Date.now(),
        lastSeenAt: Date.now(),
        passes: 0,
        failures: 0,
        consecutiveMisses: 0,
      });
      known.add(selector);
      learned++;
    }
    if (learned === 0) return 0;
    site.updatedAt = Date.now();
    this.sites.set(pending.siteKey, site);
    this.enforceCapacity();
    void this.flush();
    if (forensics.enabled) {
      forensics.count('cosmeticHidesLearned', learned);
      forensics.event('COSMETIC_HIDE_LEARNED', { count: learned, siteHash: forensics.hash(pending.siteKey) });
    }
    return learned;
  }

  /** Outcome verifier rolled the transaction back — never persist those hides. */
  public discardHides(txId: string): void {
    this.pending.delete(txId);
  }

  /**
   * Page-side replay guard verdict. `broke` = the replayed CSS collapsed the
   * page's content; matched/missed partition the replayed selectors. Repeat
   * failures or consecutive misses drop the rule (rollback guard).
   */
  public noteReplayOutcome(pageUrl: string, broke: boolean, matched: string[], missed: string[]): { dropped: number } {
    if (!this.loaded) return { dropped: 0 };
    const key = this.siteKeyOf(pageUrl);
    if (!key) return { dropped: 0 };
    const site = this.sites.get(key);
    if (!site) return { dropped: 0 };
    let dropped = 0;
    const keep: CosmeticHide[] = [];
    for (const hide of site.hides) {
      if (broke && matched.includes(hide.selector)) hide.failures++;
      if (matched.includes(hide.selector)) {
        hide.lastSeenAt = Date.now();
        hide.consecutiveMisses = 0;
        if (!broke) hide.passes++;
      }
      if (missed.includes(hide.selector)) hide.consecutiveMisses++;
      const drop = (hide.failures >= DROP_AFTER_FAILURES && hide.failures > hide.passes)
        || hide.consecutiveMisses >= DROP_AFTER_CONSECUTIVE_MISSES;
      if (drop) {
        dropped++;
        if (forensics.enabled) {
          forensics.count('cosmeticHidesDropped');
          forensics.event('COSMETIC_HIDE_DROPPED', {
            siteHash: forensics.hash(key),
            broke,
            passes: hide.passes,
            failures: hide.failures,
            consecutiveMisses: hide.consecutiveMisses,
          });
        }
      } else {
        keep.push(hide);
      }
    }
    site.hides = keep;
    site.updatedAt = Date.now();
    if (keep.length === 0) this.sites.delete(key);
    void this.flush();
    return { dropped };
  }

  private sweepPending(): void {
    const now = Date.now();
    for (const [txId, entry] of this.pending) {
      if (now - entry.at > PENDING_TTL_MS) this.pending.delete(txId);
    }
  }

  private enforceCapacity(): void {
    if (this.sites.size <= MAX_SITES) return;
    const ordered = [...this.sites.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [key] of ordered.slice(0, this.sites.size - MAX_SITES)) {
      this.sites.delete(key);
    }
  }

  private async flush(): Promise<void> {
    if (!this.loaded) return;
    try {
      const sites: Record<string, SiteCosmetics> = {};
      for (const [key, site] of this.sites) sites[key] = site;
      const shape: ProfileShape = { version: 1, sites };
      await chrome.storage.local.set({ [STORAGE_KEY]: shape });
    } catch {
      // Storage pressure must never break page protection; in-memory state survives.
    }
  }
}
