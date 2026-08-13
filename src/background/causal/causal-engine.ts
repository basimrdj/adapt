/**
 * Phase 3 M4 — transactional active experiments.
 *
 * Wraps AdaptationTransactionEngine; does not replace it.
 * Stages via stageTransaction, rolls back via AdaptationRollbackHandler,
 * verifies via AdaptationVerifier. Never auto-promotes a recipe (INV-X10).
 */

import { EventGraphStore } from './graph-store';
import { experimentToStrategy, StrategyResolutionContext } from './experiment-to-strategy';
import { AdaptationTransactionEngine } from '../../core/adaptation/engine';
import { AdaptationRollbackHandler } from '../../core/adaptation/rollback';
import { AdaptationVerifier } from '../../core/adaptation/verify';
import { DnrBackend, DnrController } from '../../core/dnr/controller';
import { NavigationRegistry } from '../../core/navigation/registry';
import { StorageBackend } from '../../core/recipes/store';
import {
  CausalDocumentKey,
  ExperimentRecord,
  HealthVectorCompact,
  hashOrigin,
} from '../../shared/causal/events';
import {
  CurrentEpochState,
  ExperimentCandidate,
  containsForbiddenToken,
  isEpochFresh,
} from '../../shared/causal/experiments';
import { STORAGE_KEYS } from '../../shared/constants';
import {
  AdaptationTransaction,
  HealthVector,
  StrategyAction,
  StrategyCandidate,
} from '../../shared/types';

export interface CausalRunContext {
  now: CurrentEpochState;
  siteKey: string;
  navigationId: string;
  baselineHealth: HealthVector;
  /** When set, verify immediately after staging (tests / settled health). */
  postHealth?: HealthVector;
}

export interface CausalExperimentState {
  record: ExperimentRecord;
  tabId: number;
  navigationEpoch: number;
  documentId: string;
  frameIds: number[];
  siteKey: string;
  navigationId: string;
  txId: string;
  sessionRuleIds: number[];
  domActionIds: string[];
  plannedActions: StrategyAction[];
  preSessionRuleIds: number[];
  baselineHealth: HealthVector;
  candidate: StrategyCandidate;
  commitProof: boolean;
  hypothesisId: `hypothesis:h${number}`;
}

export interface CausalExperimentResult {
  record: ExperimentRecord;
  transaction: AdaptationTransaction | null;
  state: CausalExperimentState | null;
}

export interface CausalEngineDeps {
  txEngine: AdaptationTransactionEngine;
  dnrController: DnrController;
  dnrBackend: DnrBackend;
  storageBackend: StorageBackend;
  registry: NavigationRegistry;
  graphStore: EventGraphStore;
  sendTabMessage: (tabId: number, msg: unknown) => Promise<void>;
  rollbackHandler?: AdaptationRollbackHandler;
  strategyResolution?: StrategyResolutionContext;
}

function toCompact(health: HealthVector): HealthVectorCompact {
  return {
    contentAccess: health.contentAvailability,
    interaction: health.interaction,
    scrollability: health.scrollability,
    visualObstruction: health.visualObstruction,
    mutationStability: health.mutationStability,
    networkIntegrity: health.networkIntegrity ?? 0.5,
    privacyPreservation: health.privacyPreservation ?? 0.5,
    confidence: health.confidence,
  };
}

function liveEpoch(
  registry: NavigationRegistry,
  tabId: number,
  frameId: number
): CurrentEpochState | null {
  const key = registry.getCausalKey(tabId, frameId);
  if (!key) return null;
  return {
    tabId: key.tabId,
    navigationEpoch: key.navigationEpoch,
    documentId: key.documentId,
    frameId: key.frameId,
  };
}

function primaryFrameId(scope: ExperimentCandidate['scope']): number {
  const first = scope.frameIds[0];
  return first === undefined ? 0 : first;
}

function isForbiddenIntervention(selected: ExperimentCandidate): boolean {
  if (containsForbiddenToken(selected.intervention.variable)) return true;
  for (const ref of selected.intervention.actionRefs) {
    if (containsForbiddenToken(ref)) return true;
  }
  return false;
}

function makeRecord(
  selected: ExperimentCandidate,
  baseline: HealthVector,
  extras: Partial<ExperimentRecord>
): ExperimentRecord {
  return {
    id: selected.id,
    candidateHash: hashOrigin(
      `${selected.id}:${selected.intervention.variable}:${selected.intervention.actionRefs.join(',')}`
    ),
    startedWallMs: Date.now(),
    status: 'ABORTED',
    preHealth: toCompact(baseline),
    observedRefs: [...selected.intervention.actionRefs],
    policyDecisionId: `policy:${selected.id}`,
    transactionId: '',
    rollbackVerified: false,
    epochStillFresh: false,
    visitId: selected.scope.documentId,
    privacyScore: baseline.privacyPreservation ?? 0.5,
    ...extras,
  };
}

function toAdaptationTx(state: CausalExperimentState): AdaptationTransaction {
  return {
    txId: state.txId,
    tabId: state.tabId,
    navigationId: state.navigationId,
    documentId: state.documentId,
    siteKey: state.siteKey,
    createdAt: state.record.startedWallMs,
    updatedAt: Date.now(),
    baselineHealth: state.baselineHealth,
    candidate: state.candidate,
    sessionRuleIds: [...state.sessionRuleIds],
    domActionIds: [...state.domActionIds],
    state: state.record.status === 'STAGED' ? 'staged' : 'rolled_back',
  };
}

export class CausalEngine {
  private readonly txEngine: AdaptationTransactionEngine;
  private readonly dnrBackend: DnrBackend;
  private readonly storageBackend: StorageBackend;
  private readonly registry: NavigationRegistry;
  private readonly graphStore: EventGraphStore;
  private readonly rollbackHandler: AdaptationRollbackHandler;
  private readonly verifier = new AdaptationVerifier();
  private readonly records = new Map<string, CausalExperimentState>();
  private readonly strategyResolution: StrategyResolutionContext | undefined;
  private initialized = false;

  constructor(deps: CausalEngineDeps) {
    this.txEngine = deps.txEngine;
    this.dnrBackend = deps.dnrBackend;
    this.storageBackend = deps.storageBackend;
    this.registry = deps.registry;
    this.graphStore = deps.graphStore;
    this.strategyResolution = deps.strategyResolution;
    this.rollbackHandler =
      deps.rollbackHandler ?? new AdaptationRollbackHandler(deps.dnrController, deps.sendTabMessage);
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    await this.txEngine.init();
    try {
      const data = await this.storageBackend.get([STORAGE_KEYS.CAUSAL_EXPERIMENTS]);
      const stored = data[STORAGE_KEYS.CAUSAL_EXPERIMENTS] as
        | Record<string, CausalExperimentState>
        | undefined;
      if (stored && typeof stored === 'object') {
        for (const [id, rec] of Object.entries(stored)) {
          this.records.set(id, rec);
        }
      }
    } catch {
      // Storage error: continue with empty in-memory map
    }

    // INV-X8: STAGED without commit proof → conservative rollback.
    const orphans: CausalExperimentState[] = [];
    for (const rec of this.records.values()) {
      if (rec.record.status === 'STAGED' && !rec.commitProof) {
        orphans.push(rec);
      }
    }
    for (const rec of orphans) {
      await this.rollbackState(rec);
    }
    this.initialized = true;
  }

  public getRecords(): CausalExperimentState[] {
    return Array.from(this.records.values());
  }

  public getRecord(id: string): CausalExperimentState | undefined {
    return this.records.get(id);
  }

  /**
   * Stage (and optionally verify) a selected causal experiment through Phase 1.
   */
  public async runCausalExperiment(
    selected: ExperimentCandidate,
    ctx: CausalRunContext
  ): Promise<CausalExperimentResult> {
    await this.init();

    const frameId = primaryFrameId(selected.scope);
    const live = liveEpoch(this.registry, selected.scope.tabId, frameId);

    // INV-X2: abort BEFORE any mutation if epoch/document/tab mismatch.
    if (!live || !isEpochFresh(selected.scope, live) || !isEpochFresh(selected.scope, ctx.now)) {
      const record = makeRecord(selected, ctx.baselineHealth, {
        status: 'STALE',
        epochStillFresh: false,
      });
      return { record, transaction: null, state: null };
    }

    // INV-X4: refuse overlapping STAGED experiment on the same tab.
    if (this.hasActiveOnTab(selected.scope.tabId)) {
      const record = makeRecord(selected, ctx.baselineHealth, {
        status: 'ABORTED',
        epochStillFresh: true,
      });
      return { record, transaction: null, state: null };
    }

    // INV-X5
    if (isForbiddenIntervention(selected)) {
      const record = makeRecord(selected, ctx.baselineHealth, {
        status: 'ABORTED',
        epochStillFresh: true,
      });
      return { record, transaction: null, state: null };
    }

    const strategy = experimentToStrategy(selected, this.strategyResolution);
    if (!strategy || strategy.actions.length === 0 || !strategy.isReversible) {
      const record = makeRecord(selected, ctx.baselineHealth, {
        status: 'ABORTED',
        epochStillFresh: true,
      });
      return { record, transaction: null, state: null };
    }

    // INV-X1: capture pre-state before mutation.
    const preRules = await this.dnrBackend.getSessionRules();
    const preSessionRuleIds = preRules.map((r) => r.id);
    const liveAfterPreState = liveEpoch(this.registry, selected.scope.tabId, frameId);
    if (
      !liveAfterPreState ||
      !isEpochFresh(selected.scope, liveAfterPreState) ||
      !isEpochFresh(selected.scope, ctx.now)
    ) {
      const record = makeRecord(selected, ctx.baselineHealth, {
        status: 'STALE',
        epochStillFresh: false,
      });
      return { record, transaction: null, state: null };
    }

    let tx: AdaptationTransaction;
    try {
      tx = await this.txEngine.stageTransaction(
        selected.scope.tabId,
        ctx.navigationId,
        ctx.siteKey,
        ctx.baselineHealth,
        strategy,
        selected.scope.documentId
      );
    } catch {
      const record = makeRecord(selected, ctx.baselineHealth, {
        status: 'ABORTED',
        epochStillFresh: true,
        rollbackVerified: true,
      });
      return { record, transaction: null, state: null };
    }

    const record = makeRecord(selected, ctx.baselineHealth, {
      status: 'STAGED',
      transactionId: tx.txId,
      epochStillFresh: true,
    });

    const state: CausalExperimentState = {
      record,
      tabId: selected.scope.tabId,
      navigationEpoch: selected.scope.navigationEpoch,
      documentId: selected.scope.documentId,
      frameIds: [...selected.scope.frameIds],
      siteKey: ctx.siteKey,
      navigationId: ctx.navigationId,
      txId: tx.txId,
      sessionRuleIds: [...tx.sessionRuleIds],
      domActionIds: [...tx.domActionIds],
      plannedActions: [...strategy.actions],
      preSessionRuleIds,
      baselineHealth: ctx.baselineHealth,
      candidate: strategy,
      commitProof: false,
      hypothesisId: selected.hypothesisRef,
    };
    this.records.set(selected.id, state);
    await this.persistRecords();

    if (ctx.postHealth) {
      return this.verifyCausalExperiment(selected.id, ctx.postHealth, ctx.now);
    }

    return { record: state.record, transaction: tx, state };
  }

  /**
   * Verify a STAGED experiment against post-intervention HealthVector.
   * Success → COMMITTED (no SiteRecipe write). Failure or stale epoch → rollback.
   */
  public async verifyCausalExperiment(
    experimentId: string,
    postHealth: HealthVector,
    now: CurrentEpochState
  ): Promise<CausalExperimentResult> {
    await this.init();
    const state = this.records.get(experimentId);
    if (!state) {
      return {
        record: {
          id: experimentId as ExperimentRecord['id'],
          candidateHash: '',
          startedWallMs: Date.now(),
          status: 'ABORTED',
          preHealth: toCompact(postHealth),
          observedRefs: [],
          policyDecisionId: '',
          transactionId: '',
          rollbackVerified: false,
          epochStillFresh: false,
        },
        transaction: null,
        state: null,
      };
    }

    if (state.record.status !== 'STAGED') {
      return { record: state.record, transaction: null, state };
    }

    const scope = {
      tabId: state.tabId,
      navigationEpoch: state.navigationEpoch,
      documentId: state.documentId,
      frameIds: state.frameIds,
    };
    const live = liveEpoch(this.registry, state.tabId, primaryFrameId(scope));
    const epochFresh = Boolean(live && isEpochFresh(scope, live) && isEpochFresh(scope, now));
    state.record.epochStillFresh = epochFresh;

    if (!epochFresh) {
      await this.rollbackState(state);
      return { record: state.record, transaction: null, state };
    }

    const tx = toAdaptationTx(state);
    const verification = this.verifier.evaluate(tx, postHealth);
    state.record.postHealth = toCompact(postHealth);
    state.record.privacyScore = postHealth.privacyPreservation ?? 0.5;
    state.record.healthDelta = verification.scoreDelta;

    if (!verification.success) {
      await this.rollbackState(state);
      return { record: state.record, transaction: null, state };
    }

    // INV-X10: do NOT write a SiteRecipe. Leave COMMITTED for M6.
    state.record.status = 'COMMITTED';
    state.record.completedWallMs = Date.now();
    state.commitProof = true;
    state.record.epochStillFresh = true;
    await this.cleanupCommittedState(state);
    this.records.set(state.record.id, state);
    await this.persistRecords();
    await this.txEngine.releaseTransaction(state.txId);
    return { record: state.record, transaction: tx, state };
  }

  /**
   * On documentId change (or any navigation of the tab): rollback then discard graph epoch.
   */
  public async onNavigation(tabId: number, previous?: CausalDocumentKey): Promise<void> {
    await this.init();
    const toRollback: CausalExperimentState[] = [];
    for (const rec of this.records.values()) {
      if (rec.tabId !== tabId) continue;
      if (rec.record.status === 'STAGED') {
        toRollback.push(rec);
      }
    }
    for (const rec of toRollback) {
      await this.rollbackState(rec);
      this.discardGraph(rec);
    }
    if (previous) {
      this.graphStore.discard(previous);
    }
  }

  private hasActiveOnTab(tabId: number): boolean {
    for (const rec of this.records.values()) {
      if (rec.tabId === tabId && rec.record.status === 'STAGED') return true;
    }
    return false;
  }

  private discardGraph(state: CausalExperimentState): void {
    const frames = state.frameIds.length > 0 ? state.frameIds : [0];
    for (const frameId of frames) {
      this.graphStore.discard({
        tabId: state.tabId,
        navigationEpoch: state.navigationEpoch,
        documentId: state.documentId,
        frameId,
      });
    }
  }

  private async rollbackState(state: CausalExperimentState): Promise<void> {
    const tx = toAdaptationTx(state);
    const result = await this.rollbackHandler.rollback(tx);

    let leftoverExperimentRules = false;
    try {
      const leftover = await this.dnrBackend.getSessionRules();
      leftoverExperimentRules = leftover.some((r) => state.sessionRuleIds.includes(r.id));
    } catch {
      leftoverExperimentRules = true;
    }

    state.record.status = 'ROLLED_BACK';
    state.record.completedWallMs = Date.now();
    state.record.rollbackVerified =
      result.sessionRulesRemoved &&
      !leftoverExperimentRules &&
      result.domActionsRolledBack === state.domActionIds.length &&
      result.errors.length === 0;
    state.commitProof = false;
    state.record.epochStillFresh = false;
    this.records.set(state.record.id, state);
    await this.persistRecords();
    await this.txEngine.releaseTransaction(state.txId);
  }

  private async cleanupCommittedState(state: CausalExperimentState): Promise<void> {
    const result = await this.rollbackHandler.rollback(toAdaptationTx(state));
    let leaked = true;
    try {
      const liveRules = await this.dnrBackend.getSessionRules();
      leaked = liveRules.some((rule) => state.sessionRuleIds.includes(rule.id));
    } catch {
      leaked = true;
    }
    state.record.rollbackVerified =
      result.sessionRulesRemoved && !leaked &&
      result.domActionsRolledBack === state.domActionIds.length && result.errors.length === 0;
  }

  private async persistRecords(): Promise<void> {
    try {
      const obj: Record<string, CausalExperimentState> = {};
      for (const [id, rec] of this.records.entries()) {
        obj[id] = rec;
      }
      await this.storageBackend.set({ [STORAGE_KEYS.CAUSAL_EXPERIMENTS]: obj });
    } catch {
      // Storage error safely ignored (same pattern as Phase 1)
    }
  }

}
