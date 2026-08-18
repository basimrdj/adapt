/**
 * PersonalLearningManager (Persistent Personal Learning, Phase A).
 *
 * Owns the learned-rule lifecycle policy on top of DnrController mechanics:
 *
 *   STAGED_SESSION      controller auto-created ownership when the rule landed
 *   HEALTHY_SESSION     outcome verifier passed (no site-health regression)
 *   PROMOTION_ELIGIBLE  bounded local evidence threshold met (see PROMOTION POLICY)
 *   PERSISTED_DYNAMIC   durable personal dynamic DNR rule confirmed present
 *   DEMOTED             stale/suspicious; first candidate for capacity eviction
 *   REVOKED             removed because evidence or site health contradicted it
 *
 * PROMOTION POLICY (documented, deterministic — never model opinion alone):
 *   1. outcome verifier marked the staged protection healthy;
 *   2. the learned request family recurred — at least PROMOTE_AFTER_MATCHES request
 *      initiations to the same host family observed AFTER the healthy mark;
 *   3. the family is third-party relative to the learning site (protected contexts
 *      were already excluded upstream by the survivor gates);
 *   4. no existing durable rule covers the family (dedupe updates metadata instead).
 *
 * WIDTH POLICY (Phase B): the EXPERIMENT width stays narrow (exact scheme + host +
 * coarse path). The LEARNED width goes host-level via DNR requestDomains when the
 * deterministic G5 guard allows it (never first-party, never shared infra). Newly
 * promoted rules are site-scoped (initiatorDomains = learning site); repeated
 * sightings from a second distinct site globalize the rule atomically. Promotion
 * installs protection immediately, so later same-session requests to the family
 * are blocked pre-request (G3 same-run consequential blocking).
 *
 * Matching is done from the in-memory identity cache — no storage reads on the
 * request hot path. Storage writes are debounced inside the ownership areas.
 */

import { DnrController, HOST_WIDE_BLOCK_RESOURCE_TYPES } from '../../core/dnr/controller';
import { OwnershipStore, LearnedRuleOwnership } from '../../core/dnr/ownership';
import { StrategyAction } from '../../shared/types';
import { isProtectedFlowHost } from '../../shared/protected-flows';
import { registrableDomain } from '../../shared/resource-identity';
import { forensics } from '../forensics/runtime-trace';

const PROMOTE_AFTER_MATCHES = 1;
/** Rules that stopped matching for this long are demoted; demoted rules are evicted first. */
const DEMOTE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const EVICT_HEADROOM = 200;
/**
 * Promotion retry discipline: a persistent failure (e.g. Chrome's dynamic quota
 * genuinely full) must not retry on every future match forever. After this many
 * consecutive failures for the same owner, promotion backs off for the cooldown
 * window — the session protection stays in place the whole time.
 */
const PROMOTE_MAX_CONSECUTIVE_FAILURES = 3;
const PROMOTE_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * G5 collateral guard (Phase B): conservative substring heuristic for neutral
 * shared infrastructure (CDNs, asset hosts, cloud edges). Hosts matching this are
 * never widened to host-wide — the narrow learned rule is kept instead. Ad/tracker
 * networks are deliberately NOT listed here; blocking those host-wide is the point.
 * AI confidence never overrides this list.
 */
const SHARED_INFRA_HOST = /(cloudflare|fastly|akamai|cloudfront|gstatic|googleapis|jsdelivr|unpkg|cdnjs|amazonaws|azureedge|cloudinary|jquery|bootstrapcdn|fbcdn|googlevideo|ytimg|ggpht|twimg|tiktokcdn|pinimg|redditmedia|imdbws|alicdn)/i;

/**
 * Sister-domain refusal (observed failure class: cnbcfm.com learned on
 * cnbc.com). A publisher's own asset CDN often lives on a sibling registrable
 * domain rather than a subdomain — the registrable-equality check cannot see
 * it. Brand-label containment (either direction, labels ≥ 4 chars) is the
 * deterministic approximation: cnbcfm ⊃ cnbc → refuse. Conservative by
 * construction — a refusal only keeps protection narrow, never weakens it.
 */
function labelsContain(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  return a.includes(b) || b.includes(a);
}

/** T8 breakage guard: blocked retries of one family within a tab over this window. */
const STORM_WINDOW_MS = 45_000;
const STORM_REVOKE_AT = 6;
/**
 * Content-type breakage net for host-wide rules. A host that passes the width
 * gate is presumed pure-adversarial — such a host never delivers page content.
 * Two blocked content fetches (image/font/stylesheet/media) against a host-wide
 * rule refute the widening itself: revoke. Narrow rules are exempt — they carry
 * their own outcome verification. Also covers legacy durable host-wide rules
 * staged before width never persisted (self-healing).
 */
const CONTENT_BREAKAGE_TYPES: ReadonlySet<string> = new Set(['image', 'font', 'stylesheet', 'media']);
const CONTENT_BREAKAGE_REVOKE_AT = 2;

/** Lowercased hostname of a URL-ish initiator string, '' when unparsable/absent. */
function hostnameOf(rawUrl?: string): string {
  if (!rawUrl) return '';
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

interface FamilyIndexEntry {
  ruleId: number;
  area: 'session' | 'durable';
  host: string;
  coarsePath: string;
  hostWide: boolean;
  resourceTypes: ReadonlySet<string>;
  lifecycle: LearnedRuleOwnership['lifecycle'];
  initiatorDomains?: string[];
}

export class PersonalLearningManager {
  private readonly ownership: OwnershipStore;
  private familyIndex = new Map<string, FamilyIndexEntry[]>(); // host → entries
  /**
   * registrableDomain(indexedHost) → indexed hosts in that bucket. Keeps the
   * subdomain-tolerance scan off the full index: candidateEntries only suffix-scans
   * hosts in the request's own bucket instead of every learned host.
   */
  private domainBucket = new Map<string, Set<string>>();
  private promotingOwners = new Set<string>();
  /** ownerId → consecutive promotion failures (drives the retry backoff). */
  private promotionFailures = new Map<string, { count: number; lastAt: number }>();
  /** txId → staged session rule ids awaiting a healthy/rollback outcome. */
  private pendingByOwner = new Map<string, number[]>();

  constructor(private readonly controller: DnrController) {
    const ownership = controller.getOwnership();
    if (!ownership) throw new Error('PersonalLearningManager requires an ownership-backed DnrController');
    this.ownership = ownership;
  }

  /** Rebuild the in-memory match index after startup ownership restore. */
  public rebuildIndex(): void {
    this.familyIndex.clear();
    this.domainBucket.clear();
    for (const record of this.ownership.session.all()) this.indexRecord(record, 'session');
    for (const record of this.ownership.durable.all()) this.indexRecord(record, 'durable');
  }

  private indexRecord(record: LearnedRuleOwnership, area: 'session' | 'durable'): void {
    if (record.lifecycle === 'REVOKED') return;
    const list = this.familyIndex.get(record.host) ?? [];
    list.push({
      ruleId: record.ruleId,
      area,
      host: record.host,
      coarsePath: record.coarsePath,
      hostWide: record.hostWide,
      resourceTypes: new Set(record.resourceTypes),
      lifecycle: record.lifecycle,
      initiatorDomains: record.initiatorDomains,
    });
    this.familyIndex.set(record.host, list);
    const bucket = registrableDomain(record.host);
    const hosts = this.domainBucket.get(bucket) ?? new Set<string>();
    hosts.add(record.host);
    this.domainBucket.set(bucket, hosts);
  }

  private unindex(ruleId: number, host: string): void {
    const list = this.familyIndex.get(host);
    if (!list) return;
    const next = list.filter((entry) => entry.ruleId !== ruleId);
    if (next.length === 0) {
      this.familyIndex.delete(host);
      const bucket = registrableDomain(host);
      const hosts = this.domainBucket.get(bucket);
      if (hosts) {
        hosts.delete(host);
        if (hosts.size === 0) this.domainBucket.delete(bucket);
      }
    } else {
      this.familyIndex.set(host, next);
    }
  }

  // ---- Lifecycle transitions -------------------------------------------------

  /** Called by the orchestrator right after a survivor-AI rule is staged. */
  public registerStagedContext(txId: string, context: { siteKey?: string; confidence?: number }): void {
    const staged = this.ownership.session.all().filter((record) => record.ownerId === txId);
    this.pendingByOwner.set(txId, staged.map((record) => record.ruleId));
    for (const record of staged) {
      this.ownership.session.upsert({
        ...record,
        learnedFromSiteKey: context.siteKey ?? record.learnedFromSiteKey,
        observedSiteKeys: context.siteKey ? [context.siteKey] : record.observedSiteKeys,
        aiConfidenceAtDiscovery: context.confidence ?? record.aiConfidenceAtDiscovery,
      });
      this.unindex(record.ruleId, record.host);
      this.indexRecord(this.ownership.session.get(record.ruleId) ?? record, 'session');
    }
  }

  /** Outcome verifier passed — the staged protection is healthy. */
  public markHealthy(txId: string): void {
    for (const ruleId of this.pendingByOwner.get(txId) ?? []) {
      const record = this.ownership.session.get(ruleId);
      if (!record || record.lifecycle !== 'STAGED_SESSION') continue;
      this.ownership.session.upsert({
        ...record,
        lifecycle: 'HEALTHY_SESSION',
        healthyObservationCount: record.healthyObservationCount + 1,
      });
      this.unindex(ruleId, record.host);
      const healthy = this.ownership.session.get(ruleId) ?? record;
      this.indexRecord(healthy, 'session');
      // Phase F: the narrow experiment proved safe — widen protection to the whole
      // host for the rest of this browser session (deterministic G5 width guard
      // inside). Later pages on this site are then covered pre-promotion and the
      // survivor-AI gate stands down.
      if (!healthy.hostWide) void this.stageHostWideTwin(healthy);
    }
    this.pendingByOwner.delete(txId);
    void this.ownership.session.flush();
  }

  /**
   * Phase F within-run widening: stage a host-wide session twin of a healthy
   * narrow rule (requestDomains = family host, site-scoped to the learning site,
   * same resource types). The twin inherits the narrow rule's healthy verdict — it
   * blocks the same family, just at host width — and the T8 retry-storm guard is
   * its regression net. Refusals (first-party, shared infra) are recorded, never
   * overridden by AI confidence.
   */
  private async stageHostWideTwin(source: LearnedRuleOwnership): Promise<void> {
    // Protected-flow guard: identity/dependency/captcha/payment endpoints are
    // never widened — a host-wide twin on a sign-in dependency CDN renders the
    // page fine and kills every click (the Google chooser dead-click class).
    if (isProtectedFlowHost(source.host)) {
      forensics.event('HOST_WIDE_STAGE_REFUSED', {
        familyHash: forensics.hash(source.requestFamilyKey),
        refusal: 'protected-flow',
      });
      return;
    }
    const width = this.decideWidth(source);
    if (!width.hostWide) {
      forensics.event('HOST_WIDE_STAGE_REFUSED', {
        familyHash: forensics.hash(source.requestFamilyKey),
        refusal: width.refusal ?? 'narrow',
      });
      return;
    }
    // One live twin per host family — later healthy marks must not stack rules.
    const twinExists = this.ownership.session.all().some((record) =>
      record.host === source.host && record.hostWide && record.lifecycle !== 'REVOKED');
    if (twinExists) return;
    // A durable host-wide rule already covering this family makes the twin moot
    // (promotion may have landed before this async staging ran).
    const durableCovers = this.ownership.durable.all().some((record) =>
      record.host === source.host && record.hostWide && record.lifecycle !== 'REVOKED');
    if (durableCovers) return;
    const action: StrategyAction = {
      id: `hostwide_${source.ruleId}`,
      type: 'NET_BLOCK',
      urlFilter: '',
      requestDomains: [source.host],
      // Host width lifts the type restriction: the width gate only passes pure
      // adversarial families, and a type-narrowed host rule leaks ping/websocket
      // telemetry to exactly the detector hosts widening exists to kill.
      resourceTypes: [...HOST_WIDE_BLOCK_RESOURCE_TYPES],
    };
    try {
      const { ruleIds } = await this.controller.addSessionExperimentRules(
        undefined,
        `hostwide_${source.ownerId}`,
        [action],
        source.learnedFromSiteKey ? [source.learnedFromSiteKey] : undefined,
      );
      const ruleId = ruleIds[0];
      const staged = ruleId === undefined ? undefined : this.ownership.session.get(ruleId);
      if (!staged) return;
      this.ownership.session.upsert({
        ...staged,
        lifecycle: 'HEALTHY_SESSION',
        hostWide: true,
        learnedFromSiteKey: source.learnedFromSiteKey,
        observedSiteKeys: source.observedSiteKeys,
        aiConfidenceAtDiscovery: source.aiConfidenceAtDiscovery,
        initiatorDomains: source.learnedFromSiteKey ? [source.learnedFromSiteKey] : undefined,
        healthyObservationCount: 1,
      });
      this.indexRecord(this.ownership.session.get(ruleId!) ?? staged, 'session');
      await this.ownership.session.flush();
      forensics.count('hostWideSessionStaged');
      forensics.event('HOST_WIDE_STAGED', { familyHash: forensics.hash(source.requestFamilyKey) });
    } catch {
      forensics.event('HOST_WIDE_STAGE_FAILED', { familyHash: forensics.hash(source.requestFamilyKey) });
    }
  }

  /** Outcome verifier rolled the experiment back — evidence is preserved. */
  public markRolledBack(txId: string): void {
    // The controller already marked the records REVOKED via the removal source;
    // the index just needs to drop them.
    for (const ruleId of this.pendingByOwner.get(txId) ?? []) {
      const record = this.ownership.session.get(ruleId);
      if (record) this.unindex(ruleId, record.host);
    }
    this.pendingByOwner.delete(txId);
  }

  // ---- Hot-path observation ----------------------------------------------------

  /**
   * A request was initiated. Returns true when a learned personal/session family
   * matched. Pure in-memory work; may schedule a debounced metadata write.
   * onBeforeRequest and onErrorOccurred both fire for a blocked request — the
   * requestId dedupe keeps one network attempt from counting as two matches.
   */
  private recentRequestIds = new Map<string, number>();
  /** `tabId|host` → timestamps of blocked attempts (T8 retry-storm detection). */
  private blockedStorms = new Map<string, number[]>();
  /** Content-type blocked stamps per tab|host — the widening regression net. */
  private blockedContentStorms = new Map<string, number[]>();

  public observeRequestInitiation(url: string, resourceType: string, initiator?: string, requestId?: string): boolean {
    if (requestId) {
      const now = Date.now();
      if ((this.recentRequestIds.get(requestId) ?? 0) > now - 5000) return true; // same attempt already counted
      if (this.recentRequestIds.size > 500) this.recentRequestIds.clear();
      this.recentRequestIds.set(requestId, now);
    }
    const entry = this.matchEntry(url, resourceType, initiator);
    if (!entry) return false;
    const area = entry.area === 'session' ? this.ownership.session : this.ownership.durable;
    const record = area.get(entry.ruleId);
    if (!record) return false;

    // A site-scoped durable rule only BLOCKS in-scope initiators. A sighting from
    // a different site is not a protection hit — it is multi-site evidence that
    // can justify safe globalization (G2).
    if (entry.area === 'durable' && entry.initiatorDomains && entry.initiatorDomains.length > 0) {
      const initiatorHost = hostnameOf(initiator);
      const inScope = initiatorHost !== '' && entry.initiatorDomains.some(
        (domain) => initiatorHost === domain || initiatorHost.endsWith(`.${domain}`)
      );
      if (!inScope) {
        forensics.count('crossSiteFamilyRecurrence');
        if (initiatorHost) void this.noteCrossSiteRecurrence(entry.ruleId, initiatorHost);
        return true;
      }
    }

    area.patch(entry.ruleId, { matchCount: record.matchCount + 1, lastMatchedAt: Date.now() });
    forensics.count('learnedRuleMatches');
    if (entry.hostWide) forensics.count('hostLevelRuleMatches');

    if (entry.area === 'session' && record.lifecycle === 'HEALTHY_SESSION' && record.matchCount + 1 >= PROMOTE_AFTER_MATCHES) {
      void this.promote(entry.ruleId);
    }
    return true;
  }

  /** A request ended with a blocker-style error matching a learned family. */
  public observeBlocked(url: string, resourceType: string, initiator?: string, requestId?: string, tabId?: number): boolean {
    const matched = this.observeRequestInitiation(url, resourceType, initiator, requestId);
    if (matched && tabId !== undefined && tabId >= 0) {
      // T8 breakage guard: a page fighting a durable learned block — or a Phase F
      // host-wide session twin (which has no outcome verifier of its own) — with a
      // retry storm on the same family within one tab is a deterministic
      // health-regression signal. Auto-revoke the implicated rule; evidence is
      // preserved as a REVOKED record with the revocation reason. Narrow session
      // experiments stay exempt: their own transaction outcome verifier owns them.
      const entry = this.matchEntry(url, resourceType, initiator);
      if (entry && (entry.area === 'durable' || entry.hostWide)) {
        const now = Date.now();
        const key = `${tabId}|${entry.host}`;
        const stamps = (this.blockedStorms.get(key) ?? []).filter((t) => now - t < STORM_WINDOW_MS);
        stamps.push(now);
        if (this.blockedStorms.size > 300) this.blockedStorms.clear();
        this.blockedStorms.set(key, stamps);
        if (stamps.length >= STORM_REVOKE_AT) {
          this.blockedStorms.delete(key);
          forensics.count('rollbackOnRegression');
          void this.revokeMatching(url, resourceType, 'retry-storm-health-regression', initiator);
        }
        if (entry.hostWide && CONTENT_BREAKAGE_TYPES.has(resourceType)) {
          const contentStamps = (this.blockedContentStorms.get(key) ?? []).filter((t) => now - t < STORM_WINDOW_MS);
          contentStamps.push(now);
          if (this.blockedContentStorms.size > 300) this.blockedContentStorms.clear();
          this.blockedContentStorms.set(key, contentStamps);
          if (contentStamps.length >= CONTENT_BREAKAGE_REVOKE_AT) {
            this.blockedContentStorms.delete(key);
            forensics.count('rollbackOnRegression');
            forensics.event('HOST_WIDE_CONTENT_BREAKAGE_REVOKE', {
              familyHash: forensics.hash(entry.host),
              resourceType,
            });
            void this.revokeMatching(url, resourceType, 'content-breakage-widening-misjudged', initiator);
          }
        }
      }
    }
    return matched;
  }

  /** Host-exact entries plus subdomain-tolerant host-wide entries for this host. */
  private candidateEntries(host: string): FamilyIndexEntry[] {
    const exact = this.familyIndex.get(host) ?? [];
    // Subdomain tolerance: only hosts in the same registrable bucket can suffix-match.
    const bucket = this.domainBucket.get(registrableDomain(host));
    if (!bucket) return exact;
    const wider: FamilyIndexEntry[] = [];
    for (const indexedHost of bucket) {
      if (indexedHost === host || !host.endsWith(`.${indexedHost}`)) continue;
      for (const entry of this.familyIndex.get(indexedHost) ?? []) {
        if (entry.hostWide) wider.push(entry);
      }
    }
    return wider.length === 0 ? exact : [...exact, ...wider];
  }

  private matchEntry(url: string, resourceType: string, initiator?: string): FamilyIndexEntry | undefined {
    let host = '';
    let pathname = '/';
    try {
      const parsed = new URL(url);
      host = parsed.hostname.toLowerCase();
      pathname = parsed.pathname;
    } catch {
      return undefined;
    }
    // Host match plus subdomain tolerance for host-wide learned rules.
    const candidates = this.candidateEntries(host);
    return candidates.find((entry) => {
      if (entry.resourceTypes.size > 0 && !entry.resourceTypes.has(resourceType)) return false;
      // Narrow DURABLE rules stay path-scoped. SESSION entries match at host
      // granularity: the experiment rule itself remains narrow, but promotion
      // evidence is host-family recurrence (G1 — the family is the host).
      if (!entry.hostWide && entry.area === 'durable' && !pathname.startsWith(entry.coarsePath)) return false;
      // Session-stage recurrence must be in-scope (the staged rule protects the
      // learning site). Durable site-scoped entries deliberately match cross-site
      // here so the caller can count globalization evidence.
      if (entry.area === 'session' && entry.initiatorDomains && entry.initiatorDomains.length > 0) {
        const initiatorHost = hostnameOf(initiator);
        if (initiatorHost === '') return false;
        const allowed = entry.initiatorDomains.some(
          (domain) => initiatorHost === domain || initiatorHost.endsWith(`.${domain}`)
        );
        if (!allowed) return false;
      }
      return true;
    });
  }

  /** Cross-site sighting of a site-scoped durable family → globalization evidence. */
  private async noteCrossSiteRecurrence(ruleId: number, initiatorHost: string): Promise<void> {
    const record = this.ownership.durable.get(ruleId);
    if (!record || record.lifecycle === 'REVOKED') return;
    const siteKeys = new Set(record.observedSiteKeys ?? []);
    if (siteKeys.has(initiatorHost)) return;
    siteKeys.add(initiatorHost);
    this.ownership.durable.patch(ruleId, { observedSiteKeys: [...siteKeys].slice(0, 8) });
    if (siteKeys.size >= 2 && record.initiatorDomains?.length) {
      const globalized = await this.controller.globalizeDurableRule(ruleId);
      if (globalized) {
        this.unindex(ruleId, record.host);
        const updated = this.ownership.durable.get(ruleId);
        if (updated) this.indexRecord(updated, 'durable');
      }
    }
    await this.ownership.durable.flush();
  }

  // ---- Promotion ---------------------------------------------------------------

  /**
   * G5 widening policy (deterministic — never model opinion):
   * refuse host-wide when the family is first-party to the learning site or looks
   * like neutral shared infrastructure; otherwise widen to the host.
   */
  private decideWidth(record: LearnedRuleOwnership): { hostWide: boolean; refusal?: string } {
    const site = record.learnedFromSiteKey;
    if (site) {
      const hostLabel = registrableDomain(record.host).split('.')[0] ?? '';
      const siteLabel = registrableDomain(site).split('.')[0] ?? '';
      if (registrableDomain(record.host) === registrableDomain(site)) {
        return { hostWide: false, refusal: 'first-party' };
      }
      if (labelsContain(hostLabel, siteLabel)) {
        return { hostWide: false, refusal: 'sister-domain' };
      }
    }
    if (SHARED_INFRA_HOST.test(record.host)) {
      return { hostWide: false, refusal: 'shared-infra' };
    }
    return { hostWide: true };
  }

  private async promote(sessionRuleId: number): Promise<void> {
    const record = this.ownership.session.get(sessionRuleId);
    if (!record || record.lifecycle !== 'HEALTHY_SESSION') return;
    // Protected-flow guard: never persist a rule against a protected flow
    // (identity, identity-dependency, captcha, payment) — and don't let the
    // session copy live on either (legacy records predate the controller-level
    // staging refusal).
    if (isProtectedFlowHost(record.host)) {
      await this.controller.removeSessionExperimentRules([sessionRuleId], 'protected-flow-purge').catch(() => undefined);
      this.unindex(sessionRuleId, record.host);
      forensics.count('protectedAuthStageRefusals');
      forensics.event('PROTECTED_AUTH_STAGE_REFUSED', { count: 1, contextHash: forensics.hash(record.requestFamilyKey) });
      return;
    }
    if (this.promotingOwners.has(record.ownerId)) return;
    // Bounded retry: a family that keeps failing promotion (persistent quota
    // exhaustion, backend outage) backs off instead of retrying on every match.
    const failure = this.promotionFailures.get(record.ownerId);
    if (
      failure
      && failure.count >= PROMOTE_MAX_CONSECUTIVE_FAILURES
      && Date.now() - failure.lastAt < PROMOTE_FAILURE_COOLDOWN_MS
    ) {
      return;
    }
    this.promotingOwners.add(record.ownerId);

    this.ownership.session.patch(sessionRuleId, { lifecycle: 'PROMOTION_ELIGIBLE' });
    forensics.count('promotionEligible');

    const width = this.decideWidth(record);
    const siteKey = record.learnedFromSiteKey;

    try {
      // Capacity first: the durable area must not grow into Chrome's hard quota.
      // Evict demoted/stale rules before asking Chrome for one more.
      const headroom = this.controller.getQuotaTracker().checkCapacity({ dynamicSafe: 1 }).availableDynamicTotal;
      await this.enforceCapacity(headroom).catch(() => 0);

      const result = await this.controller.promoteSessionRuleToDynamic(sessionRuleId, {
        ownerId: `personal_${record.host.replace(/[^a-z0-9.-]/g, '_')}`,
        reason: `healthy+recurring:${record.matchCount + 1}`,
        confidence: record.aiConfidenceAtDiscovery,
        // Durable rules NEVER carry host width. The host-wide twin inherits the
        // narrow rule's healthy verdict without an outcome verifier of its own
        // (T8 is its only net), so a width-gate miss must not persist past the
        // browser session that staged it — the cnbcfm lesson: one session's
        // widening mistake became a durable all-type block of the publisher's
        // own asset CDN (fonts, CSS, chunks, images all ERR_BLOCKED_BY_CLIENT).
        // The durable record keeps the proven narrow family shape; widening is
        // re-derived per session from the healthy narrow rule.
        hostWide: false,
        initiatorDomains: siteKey ? [siteKey] : undefined,
        siteKey,
        widthRefusalReason: width.refusal,
      });
      if (result) {
        this.promotionFailures.delete(record.ownerId);
        this.unindex(sessionRuleId, record.host);
        const durable = this.ownership.durable.get(result.dynamicRuleId);
        if (durable) this.indexRecord(durable, 'durable');
        if (!result.deduped) {
          forensics.count('dynamicRulesPromoted');
          forensics.event('RULE_PROMOTED', {
            familyHash: forensics.hash(record.requestFamilyKey),
            hostWide: durable?.hostWide === true,
          });
        }
        // A host-wide durable rule supersedes every same-site session twin for
        // this host (Phase F). Foreign-site session rules survive — they carry
        // their own multi-site evidence.
        if (durable?.hostWide) {
          const twins = this.ownership.session.all().filter((candidate) =>
            candidate.ruleId !== sessionRuleId
            && candidate.host === record.host
            && candidate.lifecycle !== 'REVOKED'
            && candidate.learnedFromSiteKey !== undefined
            && candidate.learnedFromSiteKey === record.learnedFromSiteKey);
          if (twins.length > 0) {
            for (const twin of twins) this.unindex(twin.ruleId, twin.host);
            await this.controller.removeSessionExperimentRules(twins.map((twin) => twin.ruleId), 'promotion');
          }
        }
        // Promoting a host-wide twin consumed the session rule that carried the
        // session-wide coverage, and the durable record is deliberately narrow —
        // without a replacement, subdomain coverage would regress mid-session.
        // Re-stage the twin from the same healthy evidence; the width gate
        // re-runs inside stageHostWideTwin, and later promotions dedupe onto
        // the durable narrow record instead of consuming the replacement.
        if (record.hostWide) void this.stageHostWideTwin(record);
        forensics.event('PERSONAL_RULE_COUNT', { count: this.personalRuleCount() });
      }
    } catch (error) {
      // Promotion failed — the session protection stays in place; try again on a
      // future match (bounded by PROMOTE_MAX_CONSECUTIVE_FAILURES). Surface
      // honestly in the trace. Revert only when the record is still in the
      // pre-promotion state: a concurrent T8 storm revocation or cleanup must
      // never be clobbered back to HEALTHY_SESSION.
      const current = this.ownership.session.get(sessionRuleId);
      if (current && current.lifecycle === 'PROMOTION_ELIGIBLE') {
        this.ownership.session.patch(sessionRuleId, { lifecycle: 'HEALTHY_SESSION' });
      }
      const previous = this.promotionFailures.get(record.ownerId);
      this.promotionFailures.set(record.ownerId, {
        count: (previous?.count ?? 0) + 1,
        lastAt: Date.now(),
      });
      // A quota-style rejection gets one immediate capacity sweep so the NEXT
      // attempt (after eviction had a chance to run) starts with headroom.
      if (error instanceof Error && /quota/i.test(error.message)) {
        const headroom = this.controller.getQuotaTracker().checkCapacity({ dynamicSafe: 1 }).availableDynamicTotal;
        await this.enforceCapacity(Math.min(headroom, EVICT_HEADROOM)).catch(() => 0);
      }
      forensics.event('RULE_PROMOTION_FAILED', { familyHash: forensics.hash(record.requestFamilyKey) });
    } finally {
      this.promotingOwners.delete(record.ownerId);
    }
  }

  /**
   * Worker-restart settlement. A STAGED_SESSION record whose worker died before
   * the outcome verifier ran is UNVERIFIABLE — no pending transaction survived
   * to vouch for it, and an unverified learned rule must not linger for the
   * browser session. Fail safe: remove the physical rule, keep the record as
   * REVOKED with the settlement reason. PROMOTION_ELIGIBLE records were
   * mid-promotion when the worker died: revert them to HEALTHY_SESSION (the
   * healthy mark was earned pre-restart); the startup reconciler has already
   * settled any durable PROMOTING twin from ground truth.
   */
  public async settleUnverifiedStagedRules(): Promise<number> {
    const staged = this.ownership.session.all().filter((record) => record.lifecycle === 'STAGED_SESSION');
    for (const record of staged) {
      this.unindex(record.ruleId, record.host);
      await this.controller.removeSessionExperimentRules([record.ruleId], 'worker-restart-unverified').catch(() => undefined);
    }
    for (const record of this.ownership.session.all()) {
      if (record.lifecycle !== 'PROMOTION_ELIGIBLE') continue;
      this.ownership.session.patch(record.ruleId, { lifecycle: 'HEALTHY_SESSION' });
      this.unindex(record.ruleId, record.host);
      const reverted = this.ownership.session.get(record.ruleId);
      if (reverted) this.indexRecord(reverted, 'session');
    }
    if (staged.length > 0) {
      forensics.count('unverifiedStagedRulesSettled', staged.length);
      forensics.event('UNVERIFIED_STAGED_SETTLED', { count: staged.length });
      await this.ownership.flush();
    }
    return staged.length;
  }

  // ---- Revocation / decay / capacity --------------------------------------------

  /** A promoted or session rule is implicated in a site-health regression. */
  public async revokeMatching(url: string, resourceType: string, reason: string, initiator?: string): Promise<number> {
    const entry = this.matchEntry(url, resourceType, initiator);
    if (!entry) return 0;
    const area = entry.area === 'session' ? this.ownership.session : this.ownership.durable;
    const record = area.get(entry.ruleId);
    if (!record) return 0;
    area.patch(entry.ruleId, { healthFailureCount: record.healthFailureCount + 1 });
    this.unindex(entry.ruleId, entry.host);
    if (entry.area === 'session') {
      await this.controller.removeSessionExperimentRules([entry.ruleId], 'revocation');
    } else {
      // Controller marks the durable record REVOKED and keeps the evidence trail.
      await this.controller.removeDynamicLearnedRules([entry.ruleId], reason);
    }
    forensics.count('rulesRevoked');
    forensics.event('RULE_REVOKED', { familyHash: forensics.hash(record.requestFamilyKey), reason });
    await this.ownership.flush();
    return 1;
  }

  /** Minimum deterministic decay: long-unmatched rules are demoted (evicted first). */
  public async sweepDecay(now: number = Date.now()): Promise<number> {
    let demoted = 0;
    for (const record of this.ownership.durable.all()) {
      if (record.lifecycle !== 'PERSISTED_DYNAMIC') continue;
      const lastSeen = record.lastMatchedAt ?? record.createdAt;
      if (now - lastSeen > DEMOTE_AFTER_MS) {
        this.ownership.durable.patch(record.ruleId, { lifecycle: 'DEMOTED' });
        forensics.count('rulesDemoted');
        demoted++;
      }
    }
    if (demoted > 0) await this.ownership.durable.flush();
    return demoted;
  }

  /**
   * Deterministic capacity management: when the durable area approaches the safe
   * dynamic quota, evict demoted rules first, then the stalest lowest-match rules.
   * Never silently deletes high-value rules — anything with recent matches stays.
   */
  public async enforceCapacity(availableDynamicSafe: number): Promise<number> {
    if (availableDynamicSafe > EVICT_HEADROOM) return 0;
    const candidates = this.ownership.durable.all()
      .filter((record) => record.lifecycle === 'DEMOTED' || record.lifecycle === 'PERSISTED_DYNAMIC')
      .sort((a, b) => {
        const rank = (r: LearnedRuleOwnership) => (r.lifecycle === 'DEMOTED' ? 0 : 1);
        return rank(a) - rank(b)
          || (a.lastMatchedAt ?? a.createdAt) - (b.lastMatchedAt ?? b.createdAt)
          || a.matchCount - b.matchCount;
      });
    const toEvict = candidates.slice(0, Math.max(0, EVICT_HEADROOM - availableDynamicSafe + candidates.length));
    const evictIds = toEvict
      .filter((record) => record.lifecycle === 'DEMOTED' || record.matchCount === 0)
      .map((record) => record.ruleId);
    if (evictIds.length === 0) return 0;
    // Physical removal first: if Chrome rejects it, the rules are still live and
    // both the match index and the ownership records must stay consistent with
    // that (an unindexed live rule is unmatchable — blind to health regressions).
    await this.controller.removeDynamicLearnedRules(evictIds);
    for (const id of evictIds) {
      const record = this.ownership.durable.get(id);
      if (record) this.unindex(id, record.host);
      this.ownership.durable.delete(id);
    }
    await this.ownership.durable.flush();
    return evictIds.length;
  }

  // ---- Coverage (Phase C) ---------------------------------------------------------

  /**
   * True when a learned personal rule already covers this host family. Durable
   * PERSISTED_DYNAMIC rules count; a Phase F healthy host-wide session twin also
   * counts — it already blocks the family for the rest of this browser session,
   * so the survivor-AI gate can stand down pre-promotion. Host-wide entries match
   * subdomains of the indexed host.
   */
  public isFamilyCovered(hostname: string, resourceType: string, siteKey?: string): boolean {
    const entry = this.candidateEntries(hostname.toLowerCase())
      .find((candidate) => {
        if (candidate.resourceTypes.size > 0 && !candidate.resourceTypes.has(resourceType)) return false;
        const scopeOk = !candidate.initiatorDomains || candidate.initiatorDomains.length === 0
          || (siteKey !== undefined && candidate.initiatorDomains.some((domain) => siteKey === domain || siteKey.endsWith(`.${domain}`)));
        if (!scopeOk) return false;
        if (candidate.area === 'durable') return candidate.lifecycle === 'PERSISTED_DYNAMIC';
        return candidate.lifecycle === 'HEALTHY_SESSION' && candidate.hostWide;
      });
    return entry !== undefined;
  }

  // ---- User control (Section P) -----------------------------------------------------

  public personalRuleCount(): number {
    return this.ownership.durable.all().filter(
      (record) => record.lifecycle === 'PERSISTED_DYNAMIC' || record.lifecycle === 'DEMOTED'
    ).length;
  }

  /** Full reset of adaptive memory: every durable learned rule removed and metadata wiped. */
  public async clearAll(): Promise<number> {
    const durableIds = this.ownership.durable.all().map((record) => record.ruleId);
    if (durableIds.length > 0) {
      await this.controller.removeDynamicLearnedRules(durableIds).catch(() => undefined);
    }
    await this.ownership.durable.wipe();
    this.familyIndex.clear();
    this.domainBucket.clear();
    for (const record of this.ownership.session.all()) this.indexRecord(record, 'session');
    forensics.event('PERSONAL_RULES_CLEARED', { removed: durableIds.length });
    forensics.event('PERSONAL_RULE_COUNT', { count: 0 });
    return durableIds.length;
  }
}
