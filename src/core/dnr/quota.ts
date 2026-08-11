import { QUOTA_LIMITS } from '../../shared/constants';

export interface DnrQuotaUsage {
  dynamicSafe: number;
  dynamicUnsafe: number;
  sessionRules: number;
  regexRules: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  availableDynamicSafe: number;
  availableDynamicUnsafe: number;
  availableSession: number;
}

export class DnrQuotaTracker {
  private usage: DnrQuotaUsage = {
    dynamicSafe: 0,
    dynamicUnsafe: 0,
    sessionRules: 0,
    regexRules: 0,
  };

  public updateUsage(usage: Partial<DnrQuotaUsage>): void {
    this.usage = { ...this.usage, ...usage };
  }

  public getUsage(): DnrQuotaUsage {
    return { ...this.usage };
  }

  public checkCapacity(requested: {
    dynamicSafe?: number;
    dynamicUnsafe?: number;
    session?: number;
    regex?: number;
  }): QuotaCheckResult {
    const nextDynSafe = this.usage.dynamicSafe + (requested.dynamicSafe || 0);
    const nextDynUnsafe = this.usage.dynamicUnsafe + (requested.dynamicUnsafe || 0);
    const nextSession = this.usage.sessionRules + (requested.session || 0);
    const nextRegex = this.usage.regexRules + (requested.regex || 0);

    if (nextDynSafe > QUOTA_LIMITS.MAX_DYNAMIC_SAFE) {
      return {
        allowed: false,
        reason: `Exceeds max safe dynamic rules quota (${nextDynSafe} > ${QUOTA_LIMITS.MAX_DYNAMIC_SAFE})`,
        availableDynamicSafe: Math.max(0, QUOTA_LIMITS.MAX_DYNAMIC_SAFE - this.usage.dynamicSafe),
        availableDynamicUnsafe: Math.max(0, QUOTA_LIMITS.MAX_DYNAMIC_UNSAFE - this.usage.dynamicUnsafe),
        availableSession: Math.max(0, QUOTA_LIMITS.MAX_SESSION_RULES - this.usage.sessionRules),
      };
    }

    if (nextDynUnsafe > QUOTA_LIMITS.MAX_DYNAMIC_UNSAFE) {
      return {
        allowed: false,
        reason: `Exceeds max unsafe dynamic rules quota (${nextDynUnsafe} > ${QUOTA_LIMITS.MAX_DYNAMIC_UNSAFE})`,
        availableDynamicSafe: Math.max(0, QUOTA_LIMITS.MAX_DYNAMIC_SAFE - this.usage.dynamicSafe),
        availableDynamicUnsafe: Math.max(0, QUOTA_LIMITS.MAX_DYNAMIC_UNSAFE - this.usage.dynamicUnsafe),
        availableSession: Math.max(0, QUOTA_LIMITS.MAX_SESSION_RULES - this.usage.sessionRules),
      };
    }

    if (nextSession > QUOTA_LIMITS.MAX_SESSION_RULES) {
      return {
        allowed: false,
        reason: `Exceeds max session rules quota (${nextSession} > ${QUOTA_LIMITS.MAX_SESSION_RULES})`,
        availableDynamicSafe: Math.max(0, QUOTA_LIMITS.MAX_DYNAMIC_SAFE - this.usage.dynamicSafe),
        availableDynamicUnsafe: Math.max(0, QUOTA_LIMITS.MAX_DYNAMIC_UNSAFE - this.usage.dynamicUnsafe),
        availableSession: Math.max(0, QUOTA_LIMITS.MAX_SESSION_RULES - this.usage.sessionRules),
      };
    }

    if (nextRegex > QUOTA_LIMITS.MAX_REGEX_RULES) {
      return {
        allowed: false,
        reason: `Exceeds max regex rules quota (${nextRegex} > ${QUOTA_LIMITS.MAX_REGEX_RULES})`,
        availableDynamicSafe: Math.max(0, QUOTA_LIMITS.MAX_DYNAMIC_SAFE - this.usage.dynamicSafe),
        availableDynamicUnsafe: Math.max(0, QUOTA_LIMITS.MAX_DYNAMIC_UNSAFE - this.usage.dynamicUnsafe),
        availableSession: Math.max(0, QUOTA_LIMITS.MAX_SESSION_RULES - this.usage.sessionRules),
      };
    }

    return {
      allowed: true,
      availableDynamicSafe: QUOTA_LIMITS.MAX_DYNAMIC_SAFE - this.usage.dynamicSafe,
      availableDynamicUnsafe: QUOTA_LIMITS.MAX_DYNAMIC_UNSAFE - this.usage.dynamicUnsafe,
      availableSession: QUOTA_LIMITS.MAX_SESSION_RULES - this.usage.sessionRules,
    };
  }
}
