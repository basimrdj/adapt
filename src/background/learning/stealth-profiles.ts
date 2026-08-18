/**
 * StealthProfileStore (Phase D2a — learned bait replay).
 *
 * Some detectors (detectadblock.com / Adblock Analytics kit and its clones)
 * load a vendor "bait" script whose ONLY job is a side effect — creating a
 * hidden marker div with a random-looking id. An inline checker then does
 * `getElementById('<id>')` and swaps a "you're blocking ads" wall in when the
 * div is missing. Blocking the bait (which our static plane does — these
 * vendors are trackers) is what trips them, and no generic shim can know the
 * per-deployment random id.
 *
 * This store learns the expected marker ids per site AFTER a first escape and
 * replays them (hidden, inert divs) at the start of every later visit, so the
 * checker takes the "unblocked" branch forever after. Escape-once semantics —
 * same contract as the network learning plane.
 *
 * Safety: learning is gated on ALL of
 *   1. a script request was hard-blocked (ERR_BLOCKED_BY_CLIENT) on this tab
 *      during the current navigation, and
 *   2. the candidate id comes from an inline checker-shaped script
 *      (getElementById + display swap in both branches), and
 *   3. the id looks random (10-40 alnum) and is absent from the DOM.
 * Replayed divs are display:none with no children — they take the page down
 * the exact branch it would take with no blocker present, nothing more.
 *
 * Privacy: profiles live in storage.local only, keyed by registrable site.
 */

import { registrableDomain } from '../../shared/resource-identity';
import { forensics } from '../forensics/runtime-trace';

const STORAGE_KEY = 'adapt_stealth_profiles_v1';
const MAX_SITES = 200;
const MAX_IDS_PER_SITE = 6;
const FLUSH_DEBOUNCE_MS = 1500;
const ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;
const MAX_CONSTANTS_PER_SITE = 8;
const CONSTANT_PATH = /^[A-Za-z_$][\w$]{0,63}(\.[A-Za-z_$][\w$]{0,63}){0,7}$/;
const CONSTANT_PATH_FORBIDDEN = /(^|\.)(__proto__|prototype|constructor)(\.|$)/;
const CONSTANT_PATH_ROOTS = /^(Array|Atomics|BigInt|Boolean|Date|Document|Error|Function|JSON|Math|Number|Object|Promise|Proxy|Reflect|RegExp|String|Symbol|Uint8Array|Window|chrome|document|globalThis|location|navigator|window)\./;
const CONSTANT_VALUE = /^(undefined|null|true|false|noopFunc|noopCallbackFunc|noopPromiseResolve|noopPromiseReject|trueFunc|falseFunc|emptyObj|emptyArray|emptyArr|-?\d{1,6}(\.\d{1,3})?)$/;

function validConstant(entry: StealthConstant): boolean {
  return typeof entry.path === 'string'
    && typeof entry.value === 'string'
    && CONSTANT_PATH.test(entry.path)
    && !CONSTANT_PATH_FORBIDDEN.test(entry.path)
    && !CONSTANT_PATH_ROOTS.test(entry.path)
    && CONSTANT_VALUE.test(entry.value);
}

export interface StealthConstant {
  path: string;
  value: string;
}

export interface StealthProfile {
  baitIds: string[];
  /** AI-learned detector counter-flags (Phase D2b), verified healthy before persisting. */
  constants: StealthConstant[];
  learnedAt: number;
  lastSeenAt: number;
  /** Visits where replay ran and no adblock wall became visible. */
  replayPasses: number;
  /** Visits where a wall still appeared after replay (stale id signal). */
  replayFailures: number;
}

interface ProfileShape {
  version: 1;
  sites: Record<string, StealthProfile>;
}

export class StealthProfileStore {
  private profiles = new Map<string, StealthProfile>();
  /** tabId → blocked script context for the current document. */
  private blockedScriptsByTab = new Map<number, Array<{ url: string; documentId?: string }>>();
  private loaded = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  public async load(): Promise<void> {
    // Idempotent: learn() writes through immediately, so a second load could
    // only clobber fresher in-memory state with a stale storage snapshot.
    if (this.loaded) return;
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const shape = stored[STORAGE_KEY] as ProfileShape | undefined;
      if (shape?.version === 1 && shape.sites && typeof shape.sites === 'object') {
        for (const [site, profile] of Object.entries(shape.sites)) {
          if (!Array.isArray(profile.baitIds)) continue;
          const baitIds = profile.baitIds.filter((id) => ID_PATTERN.test(id)).slice(0, MAX_IDS_PER_SITE);
          const constants = (Array.isArray(profile.constants) ? profile.constants : [])
            .filter(validConstant)
            .slice(0, MAX_CONSTANTS_PER_SITE);
          if (baitIds.length === 0 && constants.length === 0) continue;
          this.profiles.set(site, { ...profile, baitIds, constants });
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

  /** Bait ids to replay for this page url (empty when nothing learned). */
  public profileFor(url: string): string[] {
    const key = this.siteKeyOf(url);
    if (!key) return [];
    const profile = this.profiles.get(key);
    if (!profile) return [];
    profile.lastSeenAt = Date.now();
    return [...profile.baitIds];
  }

  /** Full replay surface: bait markers + AI-learned detector counter-constants. */
  public replayFor(url: string): { baitIds: string[]; constants: StealthConstant[] } {
    const key = this.siteKeyOf(url);
    if (!key) return { baitIds: [], constants: [] };
    const profile = this.profiles.get(key);
    if (!profile) return { baitIds: [], constants: [] };
    profile.lastSeenAt = Date.now();
    return { baitIds: [...profile.baitIds], constants: profile.constants.map((c) => ({ ...c })) };
  }

  /** Site-keyed variant used by the orchestrator (siteKey IS the registrable domain). */
  public learnConstantsForSite(siteKey: string, constants: StealthConstant[]): number {
    if (!this.loaded || !siteKey) return 0;
    const valid = constants.filter(validConstant);
    if (valid.length === 0) return 0;
    const profile = this.profiles.get(siteKey) ?? {
      baitIds: [],
      constants: [],
      learnedAt: Date.now(),
      lastSeenAt: Date.now(),
      replayPasses: 0,
      replayFailures: 0,
    };
    const existing = new Set(profile.constants.map((c) => `${c.path}=${c.value}`));
    let added = 0;
    for (const entry of valid) {
      if (profile.constants.length >= MAX_CONSTANTS_PER_SITE) break;
      if (existing.has(`${entry.path}=${entry.value}`)) continue;
      profile.constants.push({ ...entry });
      existing.add(`${entry.path}=${entry.value}`);
      added++;
    }
    if (added === 0) return 0;
    profile.lastSeenAt = Date.now();
    this.profiles.set(siteKey, profile);
    this.enforceCapacity();
    void this.flush();
    forensics.count('stealthConstantsLearned');
    forensics.event('STEALTH_CONSTANTS_LEARNED', { siteHash: forensics.hash(siteKey), count: added });
    return added;
  }

  /**
   * Persist AI-proposed detector counter-constants for a site. Only called after
   * the transaction's outcome verifier marked the adaptation healthy — session
   * application happens first, persistence is earned. Grammar re-validated here
   * (defense in depth); flush is immediate (crash-safe learning).
   */
  public learnConstants(url: string, constants: StealthConstant[]): number {
    if (!this.loaded) return 0;
    const key = this.siteKeyOf(url);
    if (!key) return 0;
    return this.learnConstantsForSite(key, constants);
  }

  /** A script request was hard-blocked on this tab — bait-learning context. */
  public noteBlockedScript(tabId: number, url: string, documentId?: string): void {
    if (tabId < 0) return;
    const list = this.blockedScriptsByTab.get(tabId) ?? [];
    if (!list.some((entry) => entry.url === url)) list.push({ url, documentId });
    if (list.length > 40) list.shift();
    this.blockedScriptsByTab.set(tabId, list);
    if (this.blockedScriptsByTab.size > 500) {
      const oldest = this.blockedScriptsByTab.keys().next().value;
      if (oldest !== undefined) this.blockedScriptsByTab.delete(oldest);
    }
  }

  /**
   * New main-frame navigation resets the per-tab blocked-script context — but
   * ONLY entries from older documents. Chrome delivers fresh-tab commit pairs
   * (about:blank then the real URL) and can deliver a bait request's error
   * BETWEEN them; an unconditional wipe loses that block and the learn race is
   * lost. Entries carrying the committing document's id belong to THIS
   * navigation and survive.
   */
  public resetTab(tabId: number, keepDocumentId?: string): void {
    if (!keepDocumentId) {
      this.blockedScriptsByTab.delete(tabId);
      return;
    }
    const list = this.blockedScriptsByTab.get(tabId);
    if (!list) return;
    const kept = list.filter((entry) => entry.documentId === keepDocumentId);
    if (kept.length === 0) this.blockedScriptsByTab.delete(tabId);
    else this.blockedScriptsByTab.set(tabId, kept);
  }

  public hadBlockedScript(tabId: number): boolean {
    return (this.blockedScriptsByTab.get(tabId) ?? []).length > 0;
  }

  /**
   * Learn candidate bait ids for a site. Requires the blocked-script context
   * (gate 1) — the content side enforces gates 2+3. Returns accepted ids.
   */
  public learn(tabId: number, url: string, candidates: string[]): string[] {
    if (!this.loaded || !this.hadBlockedScript(tabId)) return [];
    const key = this.siteKeyOf(url);
    if (!key) return [];
    const valid = candidates.filter((id) => ID_PATTERN.test(id)).slice(0, MAX_IDS_PER_SITE);
    if (valid.length === 0) return [];

    const profile = this.profiles.get(key) ?? {
      baitIds: [],
      constants: [],
      learnedAt: Date.now(),
      lastSeenAt: Date.now(),
      replayPasses: 0,
      replayFailures: 0,
    };
    const next = new Set(profile.baitIds);
    const accepted: string[] = [];
    for (const id of valid) {
      if (next.size >= MAX_IDS_PER_SITE) break;
      if (!next.has(id)) {
        next.add(id);
        accepted.push(id);
      }
    }
    if (accepted.length === 0) return [];
    profile.baitIds = [...next];
    profile.lastSeenAt = Date.now();
    this.profiles.set(key, profile);
    this.enforceCapacity();
    // New-id learns flush immediately — a debounced write can die with the service
    // worker (crash, browser close) and lose the learning. Learns are rare (dedupe
    // makes repeats no-ops), so the write amplification is negligible.
    void this.flush();
    forensics.count('stealthBaitIdsLearned');
    forensics.event('STEALTH_BAIT_LEARNED', { siteHash: forensics.hash(key), count: accepted.length });
    return accepted;
  }

  /** Replay outcome feedback: repeated failures mean a stale id — drop it. */
  public noteReplayOutcome(url: string, wallSeen: boolean): void {
    const key = this.siteKeyOf(url);
    const profile = key ? this.profiles.get(key) : undefined;
    if (!profile) return;
    if (wallSeen) {
      profile.replayFailures += 1;
      if (profile.replayFailures >= 3 && profile.replayFailures > profile.replayPasses) {
        this.profiles.delete(key);
        forensics.event('STEALTH_PROFILE_DROPPED', { siteHash: forensics.hash(key) });
      }
    } else {
      profile.replayPasses += 1;
    }
    this.scheduleFlush();
  }

  public count(): number {
    return this.profiles.size;
  }

  public async clearAll(): Promise<void> {
    this.profiles.clear();
    this.blockedScriptsByTab.clear();
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
    } catch {
      /* noop */
    }
  }

  private enforceCapacity(): void {
    if (this.profiles.size <= MAX_SITES) return;
    const ordered = [...this.profiles.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    for (const [key] of ordered.slice(0, this.profiles.size - MAX_SITES)) {
      this.profiles.delete(key);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  public async flush(): Promise<void> {
    if (!this.loaded) return;
    const shape: ProfileShape = {
      version: 1,
      sites: Object.fromEntries([...this.profiles.entries()].map(([key, profile]) => [key, { ...profile, baitIds: [...profile.baitIds] }])),
    };
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: shape });
    } catch {
      /* storage quota pressure — LRU keeps this bounded */
    }
  }
}
