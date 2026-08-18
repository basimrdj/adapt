import { StrategyAction } from '../../shared/types';
import { DnrIdAllocator, RuleIdAllocation } from './ids';
import { DnrQuotaTracker, QuotaCheckResult } from './quota';
import { DnrCompiler } from './compiler';
import { DnrReconciler, ReconciliationResult } from './reconcile';
import { OwnershipStore, parseLearnedUrlFilter } from './ownership';
import { filterTextMentionsProtectedFlow, isProtectedFlowHost, ruleTargetsProtectedFlow } from '../../shared/protected-flows';
import { forensics, RuleRemovalSource } from '../../background/forensics/runtime-trace';

export interface DnrBackend {
  getDynamicRules: () => Promise<chrome.declarativeNetRequest.Rule[]>;
  getSessionRules: () => Promise<chrome.declarativeNetRequest.Rule[]>;
  updateDynamicRules: (options: {
    addRules?: chrome.declarativeNetRequest.Rule[];
    removeRuleIds?: number[];
  }) => Promise<void>;
  updateSessionRules: (options: {
    addRules?: chrome.declarativeNetRequest.Rule[];
    removeRuleIds?: number[];
  }) => Promise<void>;
}

/**
 * Host-wide learned rules block every non-navigation resource type. A host that
 * earned host-wide width passed the width gate (first-party and shared-infra
 * hosts never widen), so it is treated as a pure adversarial family — and a
 * type-narrowed host rule leaks ping/websocket/media telemetry to exactly the
 * detector hosts the widening exists to kill. main_frame stays unblocked so a
 * user's intentional navigation TO the host is never intercepted.
 */
export const HOST_WIDE_BLOCK_RESOURCE_TYPES: chrome.declarativeNetRequest.ResourceType[] = [
  'sub_frame' as chrome.declarativeNetRequest.ResourceType,
  'stylesheet' as chrome.declarativeNetRequest.ResourceType,
  'script' as chrome.declarativeNetRequest.ResourceType,
  'image' as chrome.declarativeNetRequest.ResourceType,
  'font' as chrome.declarativeNetRequest.ResourceType,
  'object' as chrome.declarativeNetRequest.ResourceType,
  'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
  'ping' as chrome.declarativeNetRequest.ResourceType,
  'csp_report' as chrome.declarativeNetRequest.ResourceType,
  'media' as chrome.declarativeNetRequest.ResourceType,
  'websocket' as chrome.declarativeNetRequest.ResourceType,
  'webtransport' as chrome.declarativeNetRequest.ResourceType,
  'webbundle' as chrome.declarativeNetRequest.ResourceType,
  'other' as chrome.declarativeNetRequest.ResourceType,
];

export class DnrController {
  private idAllocator: DnrIdAllocator;
  private quotaTracker: DnrQuotaTracker;
  private compiler: DnrCompiler;
  private reconciler: DnrReconciler;
  private backend: DnrBackend;
  private ownership?: OwnershipStore;

  // Track rule metadata for quota decrements
  private sessionRuleMeta = new Map<number, { isRegex: boolean }>();
  private dynamicRuleMeta = new Map<number, { isUnsafe: boolean; isRegex: boolean }>();

  constructor(backend: DnrBackend, ownership?: OwnershipStore, initialAllocations: RuleIdAllocation[] = []) {
    this.backend = backend;
    this.ownership = ownership;
    this.idAllocator = new DnrIdAllocator(initialAllocations);
    this.quotaTracker = new DnrQuotaTracker();
    this.compiler = new DnrCompiler();
    this.reconciler = new DnrReconciler();
  }

  /**
   * Stages a temporary session rule set. Passing a tab id keeps the rule
   * tab-scoped; omitting it makes the bounded rule browser-session scoped.
   */
  public async addSessionExperimentRules(
    tabId: number | undefined,
    txId: string,
    actions: StrategyAction[],
    initiatorDomains?: string[]
  ): Promise<{ ruleIds: number[]; quotaCheck: QuotaCheckResult }> {
    const networkActions = this.dropProtectedAuthActions(actions.filter((a) => a.type.startsWith('NET_')), txId);
    if (networkActions.length === 0) {
      return {
        ruleIds: [],
        quotaCheck: {
          allowed: true,
          availableDynamicTotal: 30000,
          availableDynamicUnsafe: 5000,
          availableSession: 5000,
          availableRegexDynamic: 1000,
          availableRegexSession: 1000,
        },
      };
    }

    const regexCount = networkActions.filter((a) => 'isRegex' in a && a.isRegex).length;

    const quotaCheck = this.quotaTracker.checkCapacity({
      session: networkActions.length,
      regexSession: regexCount,
    });

    if (!quotaCheck.allowed) {
      throw new Error(`Session rule staging rejected by quota: ${quotaCheck.reason}`);
    }

    const rulesToAdd: chrome.declarativeNetRequest.Rule[] = [];
    const allocatedIds: number[] = [];

    for (const action of networkActions) {
      const band = action.type === 'NET_REDIRECT_LOCAL' ? 'SESSION_UNSAFE' : 'SESSION_SAFE';
      const id = this.idAllocator.allocate(band, txId);
      allocatedIds.push(id);

      const priorityBand = action.type === 'NET_REDIRECT_LOCAL' ? 'EXPERIMENT_REDIRECT' : 'EXPERIMENT_BLOCK';
      const compiled = this.compiler.compileAction(action, id, priorityBand, {
        tabId,
        initiatorDomains,
      });

      if (compiled) {
        rulesToAdd.push(compiled.rule);
        this.sessionRuleMeta.set(id, { isRegex: Boolean('isRegex' in action && action.isRegex) });
      }
    }

    try {
      await this.backend.updateSessionRules({ addRules: rulesToAdd });
      // Update quota tracker on successful addition
      this.quotaTracker.incrementUsage({
        sessionRules: rulesToAdd.length,
        regexSessionRules: regexCount,
      });
      if (this.ownership) {
        for (let i = 0; i < networkActions.length; i++) {
          const action = networkActions[i];
          const ruleId = allocatedIds[i];
          if (!action || ruleId === undefined) continue;
          const parsedIdentity = 'urlFilter' in action ? parseLearnedUrlFilter(String(action.urlFilter)) : undefined;
          // Host-wide learned rules carry the match in requestDomains (empty
          // urlFilter); derive the ownership identity from the domain so the
          // personal-learning family index can see them.
          const domainIdentity = !parsedIdentity && 'requestDomains' in action
            && Array.isArray(action.requestDomains) && action.requestDomains.length > 0
            ? (() => {
              const host = String(action.requestDomains![0]).toLowerCase();
              return { scheme: 'https:', authority: host, host, coarsePath: '/' };
            })()
            : undefined;
          const identity = parsedIdentity ?? domainIdentity;
          if (!identity) continue;
          const now = Date.now();
          this.ownership.session.upsert({
            schemaVersion: 1,
            ruleId,
            band: action.type === 'NET_REDIRECT_LOCAL' ? 'SESSION_UNSAFE' : 'SESSION_SAFE',
            ownerId: txId,
            lifecycle: 'STAGED_SESSION',
            createdAt: now,
            updatedAt: now,
            requestFamilyKey: `${identity.host}${identity.coarsePath}`,
            scheme: identity.scheme,
            authority: identity.authority,
            host: identity.host,
            coarsePath: identity.coarsePath,
            resourceTypes: 'resourceTypes' in action && Array.isArray(action.resourceTypes)
              ? action.resourceTypes.map(String)
              : [],
            hostWide: domainIdentity !== undefined,
            initiatorDomains: initiatorDomains && initiatorDomains.length > 0 ? [...initiatorDomains] : undefined,
            scopeClass: 'session-experiment',
            evidenceCount: 1,
            healthyObservationCount: 0,
            matchCount: 0,
            healthFailureCount: 0,
            rollbackCount: 0,
          });
        }
      }
      if (forensics.enabled) {
        forensics.count('sessionRulesInstalled', rulesToAdd.length);
        forensics.markLearnedRules(
          allocatedIds,
          networkActions.map((a) => ({
            urlFilter: 'urlFilter' in a ? String(a.urlFilter) : '',
            resourceTypes: 'resourceTypes' in a && Array.isArray(a.resourceTypes) ? a.resourceTypes.length : 0,
            tabScoped: tabId !== undefined,
          })),
          txId
        );
        forensics.event('SESSION_RULES_ADD', {
          ruleIds: allocatedIds.join(','),
          count: rulesToAdd.length,
          tabScoped: tabId !== undefined,
        });
        void forensics.snapshotSessionRules('after-add');
      }
      return { ruleIds: allocatedIds, quotaCheck };
    } catch (err) {
      // Release IDs and clean metadata if backend call fails
      for (const id of allocatedIds) {
        this.idAllocator.release(id);
        this.sessionRuleMeta.delete(id);
      }
      throw err;
    }
  }

  /**
   * Removes session rules when an experiment is rolled back or completed.
   * The backend call happens FIRST: if Chrome rejects the removal the rules are
   * still live, so allocator ids, metadata, ownership records, and quota usage
   * must all stay exactly as they were (a released id for a live rule gets
   * reused and collides; a deleted meta record makes future removals blind).
   */
  public async removeSessionExperimentRules(ruleIds: number[], source: RuleRemovalSource = 'unknown'): Promise<void> {
    if (ruleIds.length === 0) return;

    // Quota was charged per physically installed rule (meta exists exactly for
    // those). Compute the refund before the call; never refund untracked ids.
    let installedRemoved = 0;
    let regexRemoved = 0;
    for (const id of ruleIds) {
      const meta = this.sessionRuleMeta.get(id);
      if (!meta) continue;
      installedRemoved++;
      if (meta.isRegex) regexRemoved++;
    }

    try {
      await this.backend.updateSessionRules({ removeRuleIds: ruleIds });
    } catch (err) {
      if (forensics.enabled) {
        forensics.event('SESSION_RULES_REMOVE_FAILED', { ruleIds: ruleIds.join(','), count: ruleIds.length, source });
      }
      throw err;
    }

    for (const id of ruleIds) {
      this.sessionRuleMeta.delete(id);
      this.idAllocator.release(id);
      if (this.ownership) {
        if (source === 'executor-rollback' || source === 'adaptation-rollback' || source === 'revocation' || source === 'protected-flow-purge') {
          // Keep the record as REVOKED so the evidence trail survives the rule.
          const existing = this.ownership.session.get(id);
          if (existing) {
            this.ownership.session.upsert({
              ...existing,
              lifecycle: 'REVOKED',
              rollbackCount: existing.rollbackCount + 1,
              revokedReason: source,
            });
          }
        } else {
          this.ownership.session.delete(id);
        }
      }
    }

    if (forensics.enabled) {
      forensics.count('sessionRulesRemoved', ruleIds.length);
      forensics.unmarkLearnedRules(ruleIds, source);
      forensics.event('SESSION_RULES_REMOVE', { ruleIds: ruleIds.join(','), count: ruleIds.length, source });
      void forensics.snapshotSessionRules('after-remove');
    }

    this.quotaTracker.decrementUsage({
      sessionRules: installedRemoved,
      regexSessionRules: regexRemoved,
    });
  }

  /**
   * Promotes a verified successful strategy into persistent dynamic rules.
   * Callers may pass pre-allocated ids so ownership metadata can be persisted
   * BEFORE the physical rule exists (crash-safe promotion ordering).
   */
  public async persistLearnedRules(
    recipeId: string,
    actions: StrategyAction[],
    initiatorDomains?: string[],
    preAllocatedIds?: number[]
  ): Promise<number[]> {
    const networkActions = this.dropProtectedAuthActions(actions.filter((a) => a.type.startsWith('NET_')), recipeId);
    if (networkActions.length === 0) return [];

    const safeCount = networkActions.filter((a) => a.type !== 'NET_REDIRECT_LOCAL').length;
    const unsafeCount = networkActions.filter((a) => a.type === 'NET_REDIRECT_LOCAL').length;
    const regexCount = networkActions.filter((a) => 'isRegex' in a && a.isRegex).length;

    const quotaCheck = this.quotaTracker.checkCapacity({
      dynamicSafe: safeCount,
      dynamicUnsafe: unsafeCount,
      regexDynamic: regexCount,
    });

    if (!quotaCheck.allowed) {
      throw new Error(`Dynamic rule persistence rejected by quota: ${quotaCheck.reason}`);
    }

    const rulesToAdd: chrome.declarativeNetRequest.Rule[] = [];
    const allocatedIds: number[] = [];

    for (let i = 0; i < networkActions.length; i++) {
      const action = networkActions[i];
      if (!action) continue;
      const isUnsafe = action.type === 'NET_REDIRECT_LOCAL';
      const band = isUnsafe ? 'DYNAMIC_UNSAFE' : 'DYNAMIC_SAFE';
      const id = preAllocatedIds?.[i] ?? this.idAllocator.allocate(band, recipeId);
      allocatedIds.push(id);

      const priorityBand = isUnsafe ? 'PERSISTED_COMPAT_RULE' : 'PERSISTED_LEARNED_BLOCK';
      const compiled = this.compiler.compileAction(action, id, priorityBand, {
        initiatorDomains,
      });

      if (compiled) {
        rulesToAdd.push(compiled.rule);
        this.dynamicRuleMeta.set(id, {
          isUnsafe,
          isRegex: Boolean('isRegex' in action && action.isRegex),
        });
      }
    }

    try {
      await this.backend.updateDynamicRules({ addRules: rulesToAdd });
      this.quotaTracker.incrementUsage({
        dynamicSafe: safeCount,
        dynamicUnsafe: unsafeCount,
        regexDynamicRules: regexCount,
      });
      return allocatedIds;
    } catch (err) {
      for (const id of allocatedIds) {
        this.idAllocator.release(id);
        this.dynamicRuleMeta.delete(id);
      }
      throw err;
    }
  }

  /**
   * Removes persisted learned rules. When a reason is given the durable ownership
   * record is kept as REVOKED so the evidence trail outlives the rule.
   */
  public async removeDynamicLearnedRules(ruleIds: number[], revocationReason?: string): Promise<void> {
    if (ruleIds.length === 0) return;

    let safeRemoved = 0;
    let unsafeRemoved = 0;
    let regexRemoved = 0;

    for (const id of ruleIds) {
      const meta = this.dynamicRuleMeta.get(id);
      if (!meta) continue;
      if (meta.isUnsafe) unsafeRemoved++;
      else safeRemoved++;
      if (meta.isRegex) regexRemoved++;
    }

    // Backend first: on failure every piece of state stays consistent with the
    // rules that are still live in Chrome (see removeSessionExperimentRules).
    try {
      await this.backend.updateDynamicRules({ removeRuleIds: ruleIds });
    } catch (err) {
      if (forensics.enabled) {
        forensics.event('DYNAMIC_RULES_REMOVE_FAILED', { ruleIds: ruleIds.join(','), count: ruleIds.length });
      }
      throw err;
    }

    for (const id of ruleIds) {
      this.dynamicRuleMeta.delete(id);
      this.idAllocator.release(id);
      if (this.ownership && revocationReason) {
        const record = this.ownership.durable.get(id);
        if (record) {
          this.ownership.durable.upsert({
            ...record,
            lifecycle: 'REVOKED',
            rollbackCount: record.rollbackCount + 1,
            revokedReason: revocationReason,
          });
        }
      }
    }

    this.quotaTracker.decrementUsage({
      dynamicSafe: safeRemoved,
      dynamicUnsafe: unsafeRemoved,
      regexDynamicRules: regexRemoved,
    });
  }

  /**
   * Rebuilds allocator state from authoritative browser + persisted ownership state,
   * then reconciles without destroying valid learned rules. Replaces the legacy
   * memory-only reconcile that treated every post-restart rule as an orphan.
   * On success the worker-lifetime quota tracker and rule metadata maps are
   * reseeded from physical ground truth — Chrome enforces quota against the rules
   * it actually holds, so the tracker must start from the same count or every
   * subsequent capacity check drifts (over-permit until Chrome throws deferred).
   */
  public async restoreOwnershipAndReconcile(): Promise<ReconciliationResult | undefined> {
    if (!this.ownership) return undefined;
    const result = await this.reconciler.reconcile(this.idAllocator, this.ownership, this.backend);
    if (!result.reconciledSuccessfully) return result;

    this.sessionRuleMeta.clear();
    for (const observed of result.observedSession) {
      this.sessionRuleMeta.set(observed.id, { isRegex: observed.isRegex });
    }
    this.dynamicRuleMeta.clear();
    for (const observed of result.observedDynamic) {
      this.dynamicRuleMeta.set(observed.id, {
        isUnsafe: observed.band === 'DYNAMIC_UNSAFE',
        isRegex: observed.isRegex,
      });
    }
    this.quotaTracker.updateUsage({
      dynamicSafe: result.observedDynamic.filter((o) => o.band === 'DYNAMIC_SAFE').length,
      dynamicUnsafe: result.observedDynamic.filter((o) => o.band === 'DYNAMIC_UNSAFE').length,
      sessionRules: result.observedSession.length,
      regexDynamicRules: result.observedDynamic.filter((o) => o.isRegex).length,
      regexSessionRules: result.observedSession.filter((o) => o.isRegex).length,
    });
    return result;
  }

  /**
   * Crash-safe promotion: durable ownership is persisted BEFORE the physical dynamic
   * rule is installed, the install is verified via Chrome, and only then is the
   * redundant temporary session rule removed. A failure at any step leaves the
   * original session protection in place.
   */
  public async promoteSessionRuleToDynamic(
    sessionRuleId: number,
    promotion: {
      ownerId: string;
      reason: string;
      confidence?: number;
      /** Phase B: widen the learned protection to the whole host via requestDomains. */
      hostWide?: boolean;
      /** Phase B: site-scoped learned rules carry initiatorDomains until globalized. */
      initiatorDomains?: string[];
      /** Phase B: site where this recurrence was observed (multi-site evidence). */
      siteKey?: string;
      /** Why widening was refused — kept on the durable record for auditability. */
      widthRefusalReason?: string;
    }
  ): Promise<{ dynamicRuleId: number; deduped: boolean } | undefined> {
    if (!this.ownership) return undefined;
    const record = this.ownership.session.get(sessionRuleId);
    if (!record) return undefined;

    // Dedup: an existing durable rule covering this family is updated, not duplicated.
    const existing = this.ownership.durable.all().find((candidate) =>
      candidate.host === record.host
      && candidate.lifecycle !== 'REVOKED'
      && (candidate.hostWide || candidate.coarsePath === record.coarsePath)
    );
    if (existing) {
      const siteKeys = new Set(existing.observedSiteKeys ?? []);
      if (promotion.siteKey) siteKeys.add(promotion.siteKey);
      this.ownership.durable.patch(existing.ruleId, {
        evidenceCount: existing.evidenceCount + 1,
        lastMatchedAt: Date.now(),
        observedSiteKeys: [...siteKeys].slice(0, 8),
      });
      // Globalize only on repeated multi-site evidence: a second distinct site
      // justifies dropping the site scoping from the physical rule.
      if (existing.initiatorDomains?.length && siteKeys.size >= 2) {
        await this.globalizeDurableRule(existing.ruleId);
      }
      await this.ownership.durable.flush();
      // The durable rule already protects this family — the temporary session
      // rule is redundant and must not linger as a stale ownership record.
      await this.removeSessionExperimentRules([sessionRuleId], 'promotion');
      return { dynamicRuleId: existing.ruleId, deduped: true };
    }

    const dynamicId = this.idAllocator.allocate('DYNAMIC_SAFE', promotion.ownerId);
    const hostWide = promotion.hostWide === true;
    this.ownership.durable.upsert({
      ...record,
      ruleId: dynamicId,
      band: 'DYNAMIC_SAFE',
      ownerId: promotion.ownerId,
      lifecycle: 'PROMOTING',
      scopeClass: 'personal-blocklist',
      hostWide,
      initiatorDomains: promotion.initiatorDomains,
      observedSiteKeys: promotion.siteKey ? [promotion.siteKey] : record.observedSiteKeys,
      widthRefusalReason: promotion.widthRefusalReason,
      promotionReason: promotion.reason,
      aiConfidenceAtDiscovery: promotion.confidence ?? record.aiConfidenceAtDiscovery,
    });
    await this.ownership.durable.flush();

    const action = this.buildDurableAction(dynamicId, this.ownership.durable.get(dynamicId) ?? {
      ...record,
      hostWide,
    });

    try {
      await this.persistLearnedRules(promotion.ownerId, [action], promotion.initiatorDomains, [dynamicId]);
    } catch (error) {
      // A rejected add is atomic — nothing physical exists. Drop the journal
      // record so the family can be re-learned (persistLearnedRules already
      // released the pre-allocated id).
      this.ownership.durable.delete(dynamicId);
      await this.ownership.durable.flush();
      this.idAllocator.release(dynamicId);
      throw error;
    }

    let present: boolean;
    try {
      present = await this.backend.getDynamicRules()
        .then((rules) => rules.some((rule) => rule.id === dynamicId));
    } catch (verifyError) {
      // A failed READ is ambiguous — the physical rule may be live. Deleting the
      // ownership record here would orphan a live rule. Leave the PROMOTING
      // journal record and the id allocation in place: the startup reconciler
      // settles PROMOTING from physical ground truth (present → PERSISTED_DYNAMIC,
      // missing → record dropped). The session twin keeps protecting meanwhile.
      throw verifyError;
    }
    if (!present) {
      // Definitively absent — the install never landed. Safe to tear down.
      this.ownership.durable.delete(dynamicId);
      await this.ownership.durable.flush();
      this.idAllocator.release(dynamicId);
      throw new Error('dynamic-rule-verify-failed');
    }

    this.ownership.durable.patch(dynamicId, { lifecycle: 'PERSISTED_DYNAMIC' });
    // Protection is now durable; the redundant session rule may be removed.
    await this.removeSessionExperimentRules([sessionRuleId], 'promotion');
    await this.ownership.flush();
    return { dynamicRuleId: dynamicId, deduped: false };
  }


  /**
   * Builds the physical block action for a durable learned rule. Host-wide rules
   * use requestDomains (DNR-native host+subdomain matching, Chrome 101+) instead
   * of a fragile reconstructed URL string; narrow rules keep the exact learned
   * scheme/authority/coarse-path filter. Host-wide width also lifts the resource
   * type restriction (see HOST_WIDE_BLOCK_RESOURCE_TYPES) — a type-narrowed host
   * rule leaks ping/websocket telemetry to detector hosts.
   */
  private buildDurableAction(
    dynamicId: number,
    record: { scheme: string; authority: string; host: string; coarsePath: string; resourceTypes: string[]; hostWide: boolean }
  ): StrategyAction {
    if (record.hostWide) {
      return {
        id: `promote_${dynamicId}`,
        type: 'NET_BLOCK',
        urlFilter: '',
        requestDomains: [record.host],
        resourceTypes: [...HOST_WIDE_BLOCK_RESOURCE_TYPES],
      };
    }
    return {
      id: `promote_${dynamicId}`,
      type: 'NET_BLOCK',
      urlFilter: `|${record.scheme}//${record.authority}${record.coarsePath}*`,
      resourceTypes: record.resourceTypes as chrome.declarativeNetRequest.ResourceType[],
    };
  }

  /**
   * Drops the initiatorDomains site scoping from a persisted learned rule via a
   * single atomic remove+add (same rule id). Only called on multi-site evidence.
   */
  public async globalizeDurableRule(dynamicRuleId: number): Promise<boolean> {
    if (!this.ownership) return false;
    const record = this.ownership.durable.get(dynamicRuleId);
    if (!record || record.lifecycle === 'REVOKED') return false;
    if (!record.initiatorDomains?.length) return true; // already global
    const compiled = this.compiler.compileAction(
      this.buildDurableAction(dynamicRuleId, record),
      dynamicRuleId,
      'PERSISTED_LEARNED_BLOCK',
      {}
    );
    if (!compiled) return false;
    try {
      await this.backend.updateDynamicRules({
        removeRuleIds: [dynamicRuleId],
        addRules: [compiled.rule],
      });
      const present = await this.backend.getDynamicRules()
        .then((rules) => rules.some((rule) => rule.id === dynamicRuleId))
        .catch(() => false);
      if (!present) return false;
    } catch {
      return false;
    }
    this.ownership.durable.patch(dynamicRuleId, { initiatorDomains: undefined });
    await this.ownership.durable.flush();
    forensics.count('rulesGlobalized');
    forensics.event('RULE_GLOBALIZED', { familyHash: forensics.hash(record.requestFamilyKey) });
    return true;
  }

  public getOwnership(): OwnershipStore | undefined {
    return this.ownership;
  }

  public getAllAllocations(): RuleIdAllocation[] {
    return this.idAllocator.getAllAllocations();
  }

  public getQuotaTracker(): DnrQuotaTracker {
    return this.quotaTracker;
  }

  /**
   * Protected-flow guard: drop any learned rule action whose target lives on a
   * protected-flow host — dedicated identity hosts, their dependency CDNs (the
   * Google chooser dead-click class: one blocked gstatic sign-in module leaves
   * the page rendering but every click inert), captcha providers, and
   * payment/3DS hosts. No ad/tracker evidence ever justifies breaking a
   * sign-in or checkout. Fail closed, count only — host values stay out of
   * forensic artifacts (hash-only).
   */
  private dropProtectedAuthActions(actions: StrategyAction[], context: string): StrategyAction[] {
    const kept: StrategyAction[] = [];
    let refused = 0;
    for (const action of actions) {
      const urlFilter = 'urlFilter' in action ? String(action.urlFilter) : '';
      const parsedHost = urlFilter ? parseLearnedUrlFilter(urlFilter)?.host : undefined;
      const domainHosts = 'requestDomains' in action && Array.isArray(action.requestDomains)
        ? action.requestDomains.map((d) => String(d).toLowerCase())
        : [];
      const regexFilter = 'regexFilter' in action && typeof action.regexFilter === 'string'
        ? action.regexFilter
        : '';
      const protectedHit = isProtectedFlowHost(parsedHost)
        || domainHosts.some((host) => isProtectedFlowHost(host))
        || (urlFilter.length > 0 && filterTextMentionsProtectedFlow(urlFilter))
        || (regexFilter.length > 0 && filterTextMentionsProtectedFlow(regexFilter));
      if (protectedHit) {
        refused++;
        continue;
      }
      kept.push(action);
    }
    if (refused > 0 && forensics.enabled) {
      forensics.count('protectedAuthStageRefusals', refused);
      forensics.event('PROTECTED_AUTH_STAGE_REFUSED', { count: refused, contextHash: forensics.hash(context) });
    }
    return kept;
  }

  /**
   * Startup self-heal: revoke every learned rule — session or durable — whose
   * TARGET is any protected-flow host (identity, identity-dependency CDN,
   * captcha, payment/3DS). Profiles that learned rules before the guard
   * existed keep broken sign-in/checkout flows forever otherwise (the Azure
   * unknown_msal_error class and the Google chooser dead-click class). The
   * sweep is physical-first: Chrome's actual rules are ground truth, so poison
   * whose ownership metadata was lost is still removed; surviving ownership
   * records are kept as REVOKED by the removal paths. Returns the number of
   * rules removed.
   */
  public async purgeProtectedAuthRules(): Promise<number> {
    const [sessionRules, dynamicRules] = await Promise.all([
      this.backend.getSessionRules().catch(() => [] as chrome.declarativeNetRequest.Rule[]),
      this.backend.getDynamicRules().catch(() => [] as chrome.declarativeNetRequest.Rule[]),
    ]);
    const sessionIds = sessionRules.filter((rule) => ruleTargetsProtectedFlow(rule)).map((rule) => rule.id);
    const dynamicIds = dynamicRules.filter((rule) => ruleTargetsProtectedFlow(rule)).map((rule) => rule.id);
    let removed = 0;
    if (sessionIds.length > 0) {
      await this.removeSessionExperimentRules(sessionIds, 'protected-flow-purge').catch(() => undefined);
      removed += sessionIds.length;
    }
    if (dynamicIds.length > 0) {
      await this.removeDynamicLearnedRules(dynamicIds, 'protected-flow-purge').catch(() => undefined);
      removed += dynamicIds.length;
    }
    if (removed > 0 && forensics.enabled) {
      forensics.event('PROTECTED_AUTH_PURGE', { removed, session: sessionIds.length, durable: dynamicIds.length });
    }
    return removed;
  }
}
