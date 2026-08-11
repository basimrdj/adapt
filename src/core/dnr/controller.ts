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
      return { ruleIds: [], quotaCheck: { allowed: true, availableDynamicSafe: 0, availableDynamicUnsafe: 0, availableSession: 0 } };
    }

    const isRegex = networkActions.some((a) => 'isRegex' in a && a.isRegex);

    const quotaCheck = this.quotaTracker.checkCapacity({
      session: networkActions.length,
      regex: isRegex ? networkActions.length : 0,
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
      }
    }

    await this.backend.updateSessionRules({ addRules: rulesToAdd });
    return { ruleIds: allocatedIds, quotaCheck };
  }

  /**
   * Removes session rules when an experiment is rolled back or completed.
   */
  public async removeSessionExperimentRules(ruleIds: number[]): Promise<void> {
    if (ruleIds.length === 0) return;
    await this.backend.updateSessionRules({ removeRuleIds: ruleIds });
    for (const id of ruleIds) {
      this.idAllocator.release(id);
    }
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

    const quotaCheck = this.quotaTracker.checkCapacity({
      dynamicSafe: safeCount,
      dynamicUnsafe: unsafeCount,
    });

    if (!quotaCheck.allowed) {
      throw new Error(`Dynamic rule persistence rejected by quota: ${quotaCheck.reason}`);
    }

    const rulesToAdd: chrome.declarativeNetRequest.Rule[] = [];
    const allocatedIds: number[] = [];

    for (const action of networkActions) {
      const band = action.type === 'NET_REDIRECT_LOCAL' ? 'DYNAMIC_UNSAFE' : 'DYNAMIC_SAFE';
      const id = this.idAllocator.allocate(band, recipeId);
      allocatedIds.push(id);

      const priorityBand = action.type === 'NET_REDIRECT_LOCAL' ? 'PERSISTED_COMPAT_RULE' : 'PERSISTED_LEARNED_BLOCK';
      const compiled = this.compiler.compileAction(action, id, priorityBand, {
        initiatorDomains,
      });

      if (compiled) {
        rulesToAdd.push(compiled.rule);
      }
    }

    await this.backend.updateDynamicRules({ addRules: rulesToAdd });
    return allocatedIds;
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
}
