import {
  AdaptationTransaction,
  PageSignalBatch,
  HealthVector,
  StrategyCandidate,
  SiteRecipe,
} from '../../shared/types';
import { createAdaptationTransaction, updateTransactionState } from './transaction';
import { StrategyCandidateGenerator } from './candidates';
import { AdaptationVerifier } from './verify';
import { AdaptationRollbackHandler } from './rollback';
import { DnrController } from '../dnr/controller';
import { RecipeStore, StorageBackend } from '../recipes/store';
import { AuditStore } from '../audit/store';
import { calculateHealthVector } from '../health/scorer';
import { STORAGE_KEYS } from '../../shared/constants';
import { AdaptivePlanner } from '../../shared/ai/planner-interface';
import { AiNegativeMemory } from '../../background/learning/ai-negative-memory';
import { PolicyValidator } from '../../shared/ai/validator';
import { createEvidencePacket } from '../../shared/ai/evidence-builder';
import { forensics } from '../../background/forensics/runtime-trace';

export type NavigationFreshnessGuard = (tabId: number, navigationId: string) => boolean;

export class AdaptationTransactionEngine {
  private activeTransactions = new Map<string, AdaptationTransaction>();
  private stagingLocks = new Set<string>(); // Lock per tabId to prevent race conditions
  /** navigation key → planner call in flight RIGHT NOW (stampede guard). */
  private plannerInFlight = new Set<string>();
  /** navigation key → planner calls spent (the ≤2/navigation budget on this path). */
  private aiCallsByNavigation = new Map<string, number>();
  private candidateGenerator: StrategyCandidateGenerator;
  private verifier: AdaptationVerifier;
  private rollbackHandler: AdaptationRollbackHandler;
  private dnrController: DnrController;
  private recipeStore: RecipeStore;
  private auditStore: AuditStore;
  private storageBackend: StorageBackend;
  private sendTabMessage: (tabId: number, msg: unknown) => Promise<void>;
  private adaptivePlanner?: AdaptivePlanner;
  private aiNegativeMemory?: AiNegativeMemory;
  private isNavigationCurrent?: NavigationFreshnessGuard;
  private policyValidator = new PolicyValidator();
  private initialized = false;

  constructor(
    dnrController: DnrController,
    recipeStore: RecipeStore,
    auditStore: AuditStore,
    storageBackend: StorageBackend,
    sendTabMessage: (tabId: number, msg: unknown) => Promise<void>,
    adaptivePlanner?: AdaptivePlanner,
    isNavigationCurrent?: NavigationFreshnessGuard
  ) {
    this.dnrController = dnrController;
    this.recipeStore = recipeStore;
    this.auditStore = auditStore;
    this.storageBackend = storageBackend;
    this.sendTabMessage = sendTabMessage;
    this.adaptivePlanner = adaptivePlanner;
    this.isNavigationCurrent = isNavigationCurrent;
    this.candidateGenerator = new StrategyCandidateGenerator();
    this.verifier = new AdaptationVerifier();
    this.rollbackHandler = new AdaptationRollbackHandler(dnrController, sendTabMessage);
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const data = await this.storageBackend.get([STORAGE_KEYS.ACTIVE_TRANSACTIONS]);
      const stored = data[STORAGE_KEYS.ACTIVE_TRANSACTIONS] as Record<string, AdaptationTransaction> | undefined;
      if (stored && typeof stored === 'object') {
        for (const [id, tx] of Object.entries(stored)) {
          this.activeTransactions.set(id, tx);
        }
      }
      this.initialized = true;
    } catch {
      this.initialized = true;
    }
  }

  public setAdaptivePlanner(planner: AdaptivePlanner | undefined): void {
    this.adaptivePlanner = planner;
  }

  public setAiNegativeMemory(store: AiNegativeMemory | undefined): void {
    this.aiNegativeMemory = store;
  }

  private async persistActiveTransactions(): Promise<void> {
    try {
      const obj: Record<string, AdaptationTransaction> = {};
      for (const [id, tx] of this.activeTransactions.entries()) {
        if (tx.state === 'staged' || tx.state === 'observing') {
          obj[id] = tx;
        }
      }
      await this.storageBackend.set({ [STORAGE_KEYS.ACTIVE_TRANSACTIONS]: obj });
    } catch {
      // Storage error safely ignored
    }
  }

  public async evaluateSignals(
    tabId: number,
    navigationId: string,
    siteKey: string,
    batch: PageSignalBatch
  ): Promise<AdaptationTransaction | null> {
    await this.init();
    if (!this.navigationIsCurrent(tabId, navigationId)) return null;
    const health = calculateHealthVector(batch);
    if (forensics.enabled) {
      forensics.count('engineEvaluations');
      if (health.antiBlockReaction < 0.50) forensics.count('engineAntiBlockGateLow');
    }

    // If page has a high anti-block reaction (>= 0.50), initiate adaptation
    if (health.antiBlockReaction >= 0.50) {
      // Level 0: Check if site already has a confirmed recipe
      const existingRecipe = await this.recipeStore.getRecipe(siteKey);
      if (!this.navigationIsCurrent(tabId, navigationId)) return null;
      if (existingRecipe && existingRecipe.state === 'confirmed') {
        return null; // Already handled by confirmed recipe
      }

      // Check if transaction already active or currently staging for this tab
      const lockKey = `${tabId}_${siteKey}`;
      if (this.stagingLocks.has(lockKey)) {
        return null; // Concurrency protection
      }

      const existingTx = Array.from(this.activeTransactions.values()).find(
        (tx) => tx.tabId === tabId && tx.navigationId === navigationId && (tx.state === 'staged' || tx.state === 'observing')
      );
      if (existingTx) return existingTx;

      // Level 1: Deterministic Strategy Candidate Generator
      const candidates = this.candidateGenerator.generateCandidates(batch);
      let selectedCandidate: StrategyCandidate | null = (candidates.length > 0 && candidates[0]) ? candidates[0] : null;

      // Level 2: Ask the planner only when several independent signals make the
      // deterministic next action genuinely ambiguous.
      const siteCoolingDown = this.aiNegativeMemory?.isCoolingDown(siteKey) === true;
      if (forensics.enabled && !selectedCandidate && this.adaptivePlanner && siteCoolingDown && this.isAmbiguousNovelCase(batch)) {
        forensics.aiSkip('AI_SITE_COOLDOWN', { path: 'adaptation-engine' });
      }
      if (forensics.enabled && !selectedCandidate && !this.adaptivePlanner && this.isAmbiguousNovelCase(batch)) {
        forensics.aiSkip('AI_PROVIDER_UNCONFIGURED', { path: 'adaptation-engine' });
      }
      if (!selectedCandidate && this.adaptivePlanner && !siteCoolingDown && this.isAmbiguousNovelCase(batch)) {
        // Stampede guard + budget: the staging lock below is taken only AFTER the
        // planner await, and PAGE_SIGNAL_BATCH messages are not serialized — without
        // an in-flight latch and a per-navigation counter, a burst of batches burns
        // unbounded concurrent planner calls on one navigation.
        const plannerKey = `${tabId}_${navigationId}`;
        const priorCalls = this.aiCallsByNavigation.get(plannerKey) ?? 0;
        if (this.plannerInFlight.has(plannerKey) || priorCalls >= 2) {
          if (forensics.enabled) {
            forensics.aiSkip(priorCalls >= 2 ? 'AI_BUDGET_EXHAUSTED' : 'AI_CALL_IN_FLIGHT', { path: 'adaptation-engine' });
          }
        } else {
          this.plannerInFlight.add(plannerKey);
          this.aiCallsByNavigation.set(plannerKey, priorCalls + 1);
          // Bound the counter map: keys are per-navigation, so stale entries are
          // harmless but must not accumulate for the worker's lifetime.
          if (this.aiCallsByNavigation.size > 200) {
            const oldest = this.aiCallsByNavigation.keys().next().value;
            if (oldest !== undefined) this.aiCallsByNavigation.delete(oldest);
          }
          try {
            const evidence = createEvidencePacket(tabId, navigationId, siteKey, batch, health);
            if (forensics.enabled) {
              forensics.count('aiCallsStarted');
              forensics.event('AI_RUNTIME_CALL_BEGIN', {
                runtime: 'chrome-extension-service-worker',
                mock: (this.adaptivePlanner as { plannerKind?: string }).plannerKind === 'mock',
                plannerClass: (this.adaptivePlanner as { plannerKind?: string }).plannerKind ?? 'unknown',
                endpointClass: (this.adaptivePlanner as { endpointClass?: string }).endpointClass ?? 'unknown',
                triggerReason: 'ADAPTATION_ENGINE_AMBIGUOUS',
                candidateCount: evidence.candidateElements.length,
              });
            }
            const rawPlan = await this.adaptivePlanner.plan(evidence);
            if (forensics.enabled) forensics.count('aiCallsSucceeded');
            // A planner response belongs only to the document epoch that requested it.
            // Navigation can occur while the await is pending, before any transaction exists.
            if (!this.navigationIsCurrent(tabId, navigationId)) return null;
            const validation = this.policyValidator.validate(evidence, rawPlan);
            // An invalid plan built from this page's evidence is site-signaling
            // failure evidence; a valid ABSTAIN is neutral.
            if (!validation.valid) this.aiNegativeMemory?.noteFailure(siteKey, 'policy-rejected');

            if (validation.valid && validation.sanitizedPlan?.decision === 'ADAPT' && validation.mappedStrategyActions) {
              const tier = validation.sanitizedPlan.selectedStrategyTier === 'ABSTAIN' ? 'S3' : validation.sanitizedPlan.selectedStrategyTier;
              selectedCandidate = {
                id: `ai_cand_${Date.now()}`,
                tier,
                name: `AI: ${validation.sanitizedPlan.hypothesis.category}`,
                rationale: validation.sanitizedPlan.hypothesis.explanation,
                estimatedRisk: 'MEDIUM',
                actions: validation.mappedStrategyActions,
                isReversible: true,
              };
            }
          } catch {
            // AI outage fallback to fail-closed
            if (forensics.enabled) {
              forensics.count('aiCallsFailed');
              forensics.aiSkip('AI_PLANNER_FAILURE', { path: 'adaptation-engine' });
            }
            selectedCandidate = null;
          } finally {
            this.plannerInFlight.delete(plannerKey);
          }
        }
      }

      if (!selectedCandidate) return null;
      if (!this.navigationIsCurrent(tabId, navigationId)) return null;

      this.stagingLocks.add(lockKey);
      try {
        const tx = await this.stageTransaction(tabId, navigationId, siteKey, health, selectedCandidate);
        return tx;
      } finally {
        this.stagingLocks.delete(lockKey);
      }
    }

    return null;
  }

  public async stageTransaction(
    tabId: number,
    navigationId: string,
    siteKey: string,
    baselineHealth: HealthVector,
    candidate: StrategyCandidate,
    documentId?: string
  ): Promise<AdaptationTransaction> {
    await this.init();
    if (!this.navigationIsCurrent(tabId, navigationId)) {
      throw new Error('Stale navigation: refusing to stage transaction');
    }
    let tx = createAdaptationTransaction(tabId, navigationId, siteKey, baselineHealth, candidate);
    if (documentId) tx.documentId = documentId;

    try {
      // 1. Stage network actions via DNR Session Rules (tab-scoped)
      const netActions = candidate.actions.filter((a) => a.type.startsWith('NET_'));
      if (netActions.length > 0) {
        const { ruleIds } = await this.dnrController.addSessionExperimentRules(tabId, tx.txId, netActions);
        tx.sessionRuleIds = ruleIds;
      }

      // 2. Stage DOM actions in content script
      const domActions = candidate.actions.filter((a) => a.type.startsWith('DOM_'));
      for (const domAction of domActions) {
        tx.domActionIds.push(domAction.id);
        await this.sendTabMessage(tabId, {
          v: 1,
          type: 'APPLY_DOM_ACTION',
          txId: tx.txId,
          documentId,
          payload: domAction,
        });
      }

      tx = updateTransactionState(tx, 'staged');
      this.activeTransactions.set(tx.txId, tx);
      await this.persistActiveTransactions();

      await this.auditStore.recordEvent({
        id: `audit_${Date.now()}`,
        timestamp: Date.now(),
        siteKey,
        tabId,
        eventType: 'EXPERIMENT_STAGED',
        details: {
          txId: tx.txId,
          candidateName: candidate.name,
          actionsCount: candidate.actions.length,
        },
      });

      return tx;
    } catch (err) {
      if (tx.sessionRuleIds.length > 0) {
        await this.dnrController.removeSessionExperimentRules(tx.sessionRuleIds, 'engine-staging-failure').catch(() => {});
      }
      throw err;
    }
  }

  public async verifyAndCompleteTransaction(
    txId: string,
    postHealth: HealthVector
  ): Promise<AdaptationTransaction | null> {
    await this.init();
    const tx = this.activeTransactions.get(txId);
    if (!tx) return null;

    const verification = this.verifier.evaluate(tx, postHealth);
    let updatedTx: AdaptationTransaction;

    if (verification.success) {
      updatedTx = updateTransactionState(tx, 'committed', verification);

      // Create and save local site recipe
      const newRecipe: SiteRecipe = {
        schemaVersion: 1,
        siteKey: tx.siteKey,
        match: { host: tx.siteKey },
        actions: tx.candidate.actions,
        evidence: {
          successfulNavigations: 1,
          lastHealthDelta: verification.scoreDelta,
          confidence: 0.90,
          observedDetectorTypes: [],
        },
        state: 'provisional',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await this.recipeStore.saveRecipe(newRecipe);

      await this.auditStore.recordEvent({
        id: `audit_${Date.now()}`,
        timestamp: Date.now(),
        siteKey: tx.siteKey,
        tabId: tx.tabId,
        eventType: 'VERIFICATION_SUCCESS',
        details: { txId, scoreDelta: verification.scoreDelta, recipeState: 'provisional' },
      });
    } else {
      updatedTx = updateTransactionState(tx, 'rolled_back', verification);
      await this.rollbackHandler.rollback(tx);

      await this.auditStore.recordEvent({
        id: `audit_${Date.now()}`,
        timestamp: Date.now(),
        siteKey: tx.siteKey,
        tabId: tx.tabId,
        eventType: 'VERIFICATION_FAILURE',
        details: { txId, notes: verification.notes },
      });
    }

    this.activeTransactions.set(txId, updatedTx);
    await this.persistActiveTransactions();
    return updatedTx;
  }

  public getActiveTransactions(): AdaptationTransaction[] {
    return Array.from(this.activeTransactions.values());
  }

  /** Causal wrapper owns verification/promotion and releases the Phase 1 staging record. */
  public async releaseTransaction(txId: string): Promise<void> {
    this.activeTransactions.delete(txId);
    await this.persistActiveTransactions();
  }

  public async rollbackAllOrphaned(): Promise<void> {
    await this.init();
    for (const tx of this.activeTransactions.values()) {
      if (tx.state === 'staged' || tx.state === 'observing') {
        await this.rollbackHandler.rollback(tx);
        tx.state = 'rolled_back';
      }
    }
    await this.persistActiveTransactions();
  }

  private navigationIsCurrent(tabId: number, navigationId: string): boolean {
    const current = this.isNavigationCurrent?.(tabId, navigationId) ?? true;
    // A dropped evaluation is invisible from the page: count it so cold-window
    // epoch divergences are measurable instead of silently unprotected.
    if (!current && forensics.enabled) forensics.count('engineStaleNavigationDrops');
    return current;
  }

  private isAmbiguousNovelCase(batch: PageSignalBatch): boolean {
    const nonBenignSemanticSignals = (batch.semantic.categories ?? []).filter((category) =>
      category !== 'BENIGN_CONSENT' &&
      category !== 'BENIGN_NEWSLETTER' &&
      category !== 'BENIGN_LOGIN' &&
      category !== 'BENIGN_PAYWALL'
    );
    const independentSignals = [
      batch.geometry.hasFixedOverlay,
      batch.geometry.bodyScrollLocked || batch.geometry.htmlScrollLocked,
      batch.interaction.pointerEventsSuppressed,
      batch.mutation.rapidReinsertionDetected,
      nonBenignSemanticSignals.length > 0 || batch.semantic.detectedPhrases.length > 0,
      batch.suspectedDetectorTypes.includes('NETWORK_FAILURE'),
      batch.suspectedDetectorTypes.includes('POPUP_REACTION'),
    ].filter(Boolean).length;
    return independentSignals >= 2;
  }
}
