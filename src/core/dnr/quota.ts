import { QUOTA_LIMITS } from '../../shared/constants';

export interface DnrQuotaUsage {
  dynamicSafe: number;
  dynamicUnsafe: number;
  sessionRules: number;
  regexDynamicRules: number;
  regexSessionRules: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  availableDynamicTotal: number;
  availableDynamicUnsafe: number;
  availableSession: number;
  availableRegexDynamic: number;
  availableRegexSession: number;
}

export class DnrQuotaTracker {
  private usage: DnrQuotaUsage = {
    dynamicSafe: 0,
    dynamicUnsafe: 0,
    sessionRules: 0,
    regexDynamicRules: 0,
    regexSessionRules: 0,
  };

  public updateUsage(usage: Partial<DnrQuotaUsage>): void {
    this.usage = {
      ...this.usage,
      ...usage,
    };
  }

  public incrementUsage(delta: Partial<DnrQuotaUsage>): void {
    this.usage.dynamicSafe += delta.dynamicSafe || 0;
    this.usage.dynamicUnsafe += delta.dynamicUnsafe || 0;
    this.usage.sessionRules += delta.sessionRules || 0;
    this.usage.regexDynamicRules += delta.regexDynamicRules || 0;
    this.usage.regexSessionRules += delta.regexSessionRules || 0;
  }

  public decrementUsage(delta: Partial<DnrQuotaUsage>): void {
    this.usage.dynamicSafe = Math.max(0, this.usage.dynamicSafe - (delta.dynamicSafe || 0));
    this.usage.dynamicUnsafe = Math.max(0, this.usage.dynamicUnsafe - (delta.dynamicUnsafe || 0));
    this.usage.sessionRules = Math.max(0, this.usage.sessionRules - (delta.sessionRules || 0));
    this.usage.regexDynamicRules = Math.max(0, this.usage.regexDynamicRules - (delta.regexDynamicRules || 0));
    this.usage.regexSessionRules = Math.max(0, this.usage.regexSessionRules - (delta.regexSessionRules || 0));
  }

  public getUsage(): DnrQuotaUsage {
    return { ...this.usage };
  }

  public checkCapacity(requested: {
    dynamicSafe?: number;
    dynamicUnsafe?: number;
    session?: number;
    regexDynamic?: number;
    regexSession?: number;
  }): QuotaCheckResult {
    const nextDynSafe = this.usage.dynamicSafe + (requested.dynamicSafe || 0);
    const nextDynUnsafe = this.usage.dynamicUnsafe + (requested.dynamicUnsafe || 0);
    const nextTotalDynamic = nextDynSafe + nextDynUnsafe;
    const nextSession = this.usage.sessionRules + (requested.session || 0);
    const nextRegexDyn = this.usage.regexDynamicRules + (requested.regexDynamic || 0);
    const nextRegexSess = this.usage.regexSessionRules + (requested.regexSession || 0);

    const totalDynamicLimit = QUOTA_LIMITS.MAX_DYNAMIC_SAFE; // 30,000 total dynamic rules
    const unsafeDynamicLimit = QUOTA_LIMITS.MAX_DYNAMIC_UNSAFE; // 5,000 max unsafe dynamic rules

    // 1. Total dynamic rules cannot exceed MAX_DYNAMIC_SAFE (30,000)
    if (nextTotalDynamic > totalDynamicLimit) {
      return {
        allowed: false,
        reason: `Exceeds max total dynamic rules quota (${nextTotalDynamic} > ${totalDynamicLimit})`,
        availableDynamicTotal: Math.max(0, totalDynamicLimit - (this.usage.dynamicSafe + this.usage.dynamicUnsafe)),
        availableDynamicUnsafe: Math.max(0, unsafeDynamicLimit - this.usage.dynamicUnsafe),
        availableSession: Math.max(0, QUOTA_LIMITS.MAX_SESSION_RULES - this.usage.sessionRules),
        availableRegexDynamic: Math.max(0, QUOTA_LIMITS.MAX_REGEX_RULES - this.usage.regexDynamicRules),
        availableRegexSession: Math.max(0, QUOTA_LIMITS.MAX_REGEX_RULES - this.usage.regexSessionRules),
      };
    }

    // 2. Unsafe dynamic rules cannot exceed MAX_DYNAMIC_UNSAFE (5,000)
    if (nextDynUnsafe > unsafeDynamicLimit) {
      return {
        allowed: false,
        reason: `Exceeds max unsafe dynamic rules quota (${nextDynUnsafe} > ${unsafeDynamicLimit})`,
        availableDynamicTotal: Math.max(0, totalDynamicLimit - (this.usage.dynamicSafe + this.usage.dynamicUnsafe)),
        availableDynamicUnsafe: Math.max(0, unsafeDynamicLimit - this.usage.dynamicUnsafe),
        availableSession: Math.max(0, QUOTA_LIMITS.MAX_SESSION_RULES - this.usage.sessionRules),
        availableRegexDynamic: Math.max(0, QUOTA_LIMITS.MAX_REGEX_RULES - this.usage.regexDynamicRules),
        availableRegexSession: Math.max(0, QUOTA_LIMITS.MAX_REGEX_RULES - this.usage.regexSessionRules),
      };
    }

    // 3. Session rules quota
    if (nextSession > QUOTA_LIMITS.MAX_SESSION_RULES) {
      return {
        allowed: false,
        reason: `Exceeds max session rules quota (${nextSession} > ${QUOTA_LIMITS.MAX_SESSION_RULES})`,
        availableDynamicTotal: Math.max(0, totalDynamicLimit - (this.usage.dynamicSafe + this.usage.dynamicUnsafe)),
        availableDynamicUnsafe: Math.max(0, unsafeDynamicLimit - this.usage.dynamicUnsafe),
        availableSession: Math.max(0, QUOTA_LIMITS.MAX_SESSION_RULES - this.usage.sessionRules),
        availableRegexDynamic: Math.max(0, QUOTA_LIMITS.MAX_REGEX_RULES - this.usage.regexDynamicRules),
        availableRegexSession: Math.max(0, QUOTA_LIMITS.MAX_REGEX_RULES - this.usage.regexSessionRules),
      };
    }

    // 4. Regex dynamic rules quota (per-ruleset)
    if (nextRegexDyn > QUOTA_LIMITS.MAX_REGEX_RULES) {
      return {
        allowed: false,
        reason: `Exceeds max regex dynamic rules quota (${nextRegexDyn} > ${QUOTA_LIMITS.MAX_REGEX_RULES})`,
        availableDynamicTotal: Math.max(0, totalDynamicLimit - (this.usage.dynamicSafe + this.usage.dynamicUnsafe)),
        availableDynamicUnsafe: Math.max(0, unsafeDynamicLimit - this.usage.dynamicUnsafe),
        availableSession: Math.max(0, QUOTA_LIMITS.MAX_SESSION_RULES - this.usage.sessionRules),
        availableRegexDynamic: Math.max(0, QUOTA_LIMITS.MAX_REGEX_RULES - this.usage.regexDynamicRules),
        availableRegexSession: Math.max(0, QUOTA_LIMITS.MAX_REGEX_RULES - this.usage.regexSessionRules),
      };
    }

    // 5. Regex session rules quota (per-ruleset)
    if (nextRegexSess > QUOTA_LIMITS.MAX_REGEX_RULES) {
      return {
        allowed: false,
        reason: `Exceeds max regex session rules quota (${nextRegexSess} > ${QUOTA_LIMITS.MAX_REGEX_RULES})`,
        availableDynamicTotal: Math.max(0, totalDynamicLimit - (this.usage.dynamicSafe + this.usage.dynamicUnsafe)),
        availableDynamicUnsafe: Math.max(0, unsafeDynamicLimit - this.usage.dynamicUnsafe),
        availableSession: Math.max(0, QUOTA_LIMITS.MAX_SESSION_RULES - this.usage.sessionRules),
        availableRegexDynamic: Math.max(0, QUOTA_LIMITS.MAX_REGEX_RULES - this.usage.regexDynamicRules),
        availableRegexSession: Math.max(0, QUOTA_LIMITS.MAX_REGEX_RULES - this.usage.regexSessionRules),
      };
    }

    return {
      allowed: true,
      availableDynamicTotal: totalDynamicLimit - nextTotalDynamic,
      availableDynamicUnsafe: unsafeDynamicLimit - nextDynUnsafe,
      availableSession: QUOTA_LIMITS.MAX_SESSION_RULES - nextSession,
      availableRegexDynamic: QUOTA_LIMITS.MAX_REGEX_RULES - nextRegexDyn,
      availableRegexSession: QUOTA_LIMITS.MAX_REGEX_RULES - nextRegexSess,
    };
  }
}
