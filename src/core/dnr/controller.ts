import { StrategyAction } from '../../shared/types';
import { DnrIdAllocator, RuleIdAllocation } from './ids';
import { DnrQuotaTracker, QuotaCheckResult } from './quota';
import { DnrCompiler } from './compiler';
import { DnrReconciler, ReconciliationResult } from './reconcile';

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

export class DnrController {
  private idAllocator: DnrIdAllocator;
  private quotaTracker: DnrQuotaTracker;
  private compiler: DnrCompiler;
  private reconciler: DnrReconciler;
  private backend: DnrBackend;

  // Track rule metadata for quota decrements
  private sessionRuleMeta = new Map<number, { isRegex: boolean }>();
  private dynamicRuleMeta = new Map<number, { isUnsafe: boolean; isRegex: boolean }>();

  constructor(backend: DnrBackend, initialAllocations: RuleIdAllocation[] = []) {
    this.backend = backend;
    this.idAllocator = new DnrIdAllocator(initialAllocations);
    this.quotaTracker = new DnrQuotaTracker();
    this.compiler = new DnrCompiler();
    this.reconciler = new DnrReconciler();
  }

  /**
   * Stages a temporary, tab-scoped session rule set for an active experiment.
   */
  public async addSessionExperimentRules(
    tabId: number,
    txId: string,
    actions: StrategyAction[],
    initiatorDomains?: string[]
  ): Promise<{ ruleIds: number[]; quotaCheck: QuotaCheckResult }> {
    const networkActions = actions.filter((a) => a.type.startsWith('NET_'));
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
   */
  public async removeSessionExperimentRules(ruleIds: number[]): Promise<void> {
    if (ruleIds.length === 0) return;

    let regexRemoved = 0;
    for (const id of ruleIds) {
      const meta = this.sessionRuleMeta.get(id);
      if (meta?.isRegex) regexRemoved++;
      this.sessionRuleMeta.delete(id);
      this.idAllocator.release(id);
    }

    await this.backend.updateSessionRules({ removeRuleIds: ruleIds });

    this.quotaTracker.decrementUsage({
      sessionRules: ruleIds.length,
      regexSessionRules: regexRemoved,
    });
  }

  /**
   * Promotes a verified successful strategy into persistent dynamic rules.
   */
  public async persistLearnedRules(
    recipeId: string,
    actions: StrategyAction[],
    initiatorDomains?: string[]
  ): Promise<number[]> {
    const networkActions = actions.filter((a) => a.type.startsWith('NET_'));
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

    for (const action of networkActions) {
      const isUnsafe = action.type === 'NET_REDIRECT_LOCAL';
      const band = isUnsafe ? 'DYNAMIC_UNSAFE' : 'DYNAMIC_SAFE';
      const id = this.idAllocator.allocate(band, recipeId);
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
   * Removes persisted learned rules.
   */
  public async removeDynamicLearnedRules(ruleIds: number[]): Promise<void> {
    if (ruleIds.length === 0) return;

    let safeRemoved = 0;
    let unsafeRemoved = 0;
    let regexRemoved = 0;

    for (const id of ruleIds) {
      const meta = this.dynamicRuleMeta.get(id);
      if (meta) {
        if (meta.isUnsafe) unsafeRemoved++;
        else safeRemoved++;
        if (meta.isRegex) regexRemoved++;
        this.dynamicRuleMeta.delete(id);
      }
      this.idAllocator.release(id);
    }

    await this.backend.updateDynamicRules({ removeRuleIds: ruleIds });

    this.quotaTracker.decrementUsage({
      dynamicSafe: safeRemoved,
      dynamicUnsafe: unsafeRemoved,
      regexDynamicRules: regexRemoved,
    });
  }

  /**
   * Reconciles physical rules with logical state.
   */
  public async reconcile(knownActiveOwnerIds: Set<string>): Promise<ReconciliationResult> {
    return this.reconciler.reconcile(this.idAllocator, knownActiveOwnerIds, this.backend);
  }

  public getAllAllocations(): RuleIdAllocation[] {
    return this.idAllocator.getAllAllocations();
  }

  public getQuotaTracker(): DnrQuotaTracker {
    return this.quotaTracker;
  }
}
