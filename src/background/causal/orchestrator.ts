import { calculateHealthVector } from '../../core/health/scorer';
import { NavigationRegistry } from '../../core/navigation/registry';
import { normalizeUrlForTelemetry } from '../../core/network/normalize-url';
import { RequestGraphManager } from '../../core/network/request-graph';
import {
  CausalDocumentKey,
  CausalHypothesis,
  createEventId,
  EventNode,
  hashOrigin,
  HealthVectorCompact,
  OpaqueRef,
} from '../../shared/causal/events';
import { ExperimentSelectionBudget } from '../../shared/causal/experiments';
import { CausalPageObservationBatch, HealthVector, StrategyAction } from '../../shared/types';
import {
  checkFingerprint,
  CausalRecipeLifecycle,
  createPageFingerprint,
  fingerprintEvidenceHash,
  isIdentityMismatch,
  PageFingerprint,
} from '../../shared/causal/recipes';
import { BeliefUpdater } from './belief-updater';
import { CandidateGenerator } from './candidate-generator';
import { CausalEngine } from './causal-engine';
import { EventNormalizer, RawNavigationEvent, RawRequestEvent, stablePositiveIntFromRequestId } from './event-normalizer';
import { ExperimentGenerator } from './experiment-generator';
import { ExperimentSelector } from './experiment-selector';
import { EventGraphStore } from './graph-store';
import { CausalSessionStateRepository } from './session-state';
import { ResolvedNetworkTarget, StrategyResolutionContext } from './experiment-to-strategy';
import { CausalRecipeStore, PromotionEvaluateInput, PromotionGate } from './promotion-gate';
import { verifyHealthOutcome } from '../../core/health/compare';

const TRACKER_LIKE = /(^|[.-])(ads?|analytics|beacon|pixel|track(er|ing)?)([.-]|$)/i;

function compactScore(h: HealthVector): number {
  return (
    (1 - h.antiBlockReaction) * 0.35 +
    h.contentAvailability * 0.25 +
    h.interaction * 0.15 +
    h.scrollability * 0.1 +
    (1 - h.visualObstruction) * 0.1 +
    h.mutationStability * 0.05
  );
}

function nowNode(scope: CausalDocumentKey, originHash: string, kind: EventNode['kind'], refs: OpaqueRef[], features: EventNode['features'], provenance: EventNode['provenance'], timestamp: number): EventNode {
  return {
    id: createEventId(),
    kind,
    scope: { ...scope, originHash },
    timestamp: { value: timestamp, domain: 'extension.wall_ms' },
    refs,
    features,
    provenance,
    observationConfidence: 0.9,
  };
}

export class CausalResourceRegistry implements StrategyResolutionContext {
  private readonly requests = new Map<`request:r${number}`, ResolvedNetworkTarget>();

  observe(raw: RawRequestEvent, pageOrigin: string): void {
    if (!raw.requestId) return;
    try {
      const target = new URL(raw.url);
      const page = new URL(pageOrigin);
      const normalized = normalizeUrlForTelemetry(raw.url);
      const ref = `request:r${stablePositiveIntFromRequestId(raw.requestId)}` as const;
      const type = (raw.resourceType || 'xmlhttprequest') as chrome.declarativeNetRequest.ResourceType;
      this.requests.set(ref, {
        urlFilter: `|${target.protocol}//${normalized.hostname}${normalized.coarsePath}*`,
        resourceTypes: [type],
        firstParty: target.hostname === page.hostname,
        trackerLike: TRACKER_LIKE.test(target.hostname),
      });
    } catch {
      // Invalid URL is not an actionable resource.
    }
  }

  resolveRequest(ref: `request:r${number}`): ResolvedNetworkTarget | undefined {
    const value = this.requests.get(ref);
    return value ? { ...value, resourceTypes: [...value.resourceTypes] } : undefined;
  }
}

export interface CausalOrchestratorDeps {
  registry: NavigationRegistry;
  requestGraphs: RequestGraphManager;
  graphs: EventGraphStore;
  beliefs: BeliefUpdater;
  engine: CausalEngine;
  session: CausalSessionStateRepository;
  sendTabMessage: (tabId: number, message: unknown) => Promise<void>;
  recipeStore: CausalRecipeStore;
  promotion: PromotionGate;
  runFallback: (tabId: number, navigationId: string, siteKey: string, batch: CausalPageObservationBatch['pageSignals']) => Promise<unknown>;
}

interface PendingReplay {
  txId: string;
  tabId: number;
  documentId: string;
  frameId: number;
  baseline: HealthVector;
  fingerprint: PageFingerprint;
  recordId: `recipe:rcp${number}`;
  applied: StrategyAction[];
  applicationKey: string;
  keepAppliedOnSuccess: boolean;
}

const PROMOTABLE_MECHANISMS: ReadonlySet<CausalHypothesis['mechanismClass']> = new Set([
  'BLOCKED_RESOURCE_PROBE',
  'BAIT_VISIBILITY_PROBE',
  'OVERLAY_REINSERTION',
  'SCROLL_LOCK_REACTION',
  'SERVICE_WORKER_CACHE_PATH',
  'SCRIPT_ORDER_DEPENDENCY',
  'COSMETIC_REMOVAL_DEPENDENCY',
  'UNKNOWN',
]);

export class CausalOrchestrator {
  private readonly normalizer: EventNormalizer;
  private readonly candidates = new CandidateGenerator();
  private readonly experiments = new ExperimentGenerator();
  private readonly selector = new ExperimentSelector();
  private readonly previousHealth = new Map<string, HealthVector>();
  private readonly pendingReplays = new Map<string, PendingReplay>();
  private readonly completedRecipeApplications = new Set<string>();
  private readonly attemptedMechanisms = new Map<string, Set<CausalHypothesis['mechanismClass']>>();
  private readonly lastFingerprints = new Map<string, PageFingerprint>();
  private readonly lastBatches = new Map<string, CausalPageObservationBatch['pageSignals']>();

  constructor(private readonly deps: CausalOrchestratorDeps) {
    this.normalizer = new EventNormalizer(deps.registry);
  }

  async onNavigation(raw: RawNavigationEvent): Promise<void> {
    const node = this.normalizer.normalizeNavigation(raw);
    if (!node) return;
    const key = this.deps.registry.getCausalKey(raw.tabId, raw.frameId);
    if (!key) return;
    const graph = this.deps.graphs.getOrCreate(key, node.scope.originHash);
    this.deps.graphs.append(node);
    this.candidates.update(graph);
    await this.deps.session.persist();
  }

  async onRequest(raw: RawRequestEvent, resources: CausalResourceRegistry): Promise<void> {
    const epoch = this.deps.registry.getEpoch(raw.tabId, raw.frameId);
    if (!epoch) return;
    resources.observe(raw, epoch.origin);
    const node = this.normalizer.normalizeRequest(raw);
    if (!node) return;
    const key = this.deps.registry.getCausalKey(raw.tabId, raw.frameId);
    if (!key) return;
    const graph = this.deps.graphs.getOrCreate(key, node.scope.originHash);
    this.deps.graphs.append(node);
    this.candidates.update(graph);
    await this.deps.session.persist();
  }

  async onPageObservation(tabId: number, frameId: number, batch: CausalPageObservationBatch): Promise<boolean> {
    const epoch = this.deps.registry.getEpoch(tabId, frameId);
    const scope = this.deps.registry.getCausalKey(tabId, frameId);
    // The content script cannot know the background navigationId. Identity was
    // already authenticated from MessageSender.documentId before this call.
    if (!epoch || !scope) return false;
    const graph = this.deps.graphs.getOrCreate(scope, hashOrigin(epoch.origin));
    this.lastBatches.set(`${tabId}:${frameId}:${scope.documentId}`, batch.pageSignals);
    this.lastFingerprints.set(graph.graphId, this.fingerprint(graph, batch, epoch.url));
    const health = this.enrichHealth(calculateHealthVector(batch.pageSignals), epoch.navigationId);
    const key = `${tabId}:${frameId}:${scope.navigationEpoch}:${scope.documentId}`;
    const prior = this.previousHealth.get(key);
    const delta = prior ? compactScore(health) - compactScore(prior) : 0;
    this.previousHealth.set(key, health);

    this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'HEALTH_SNAPSHOT', [], {
      delta,
      antiBlockReaction: health.antiBlockReaction,
      networkIntegrity: health.networkIntegrity ?? 0.5,
      privacyPreservation: health.privacyPreservation ?? 0.5,
    }, 'healthVector', batch.timestamp));

    for (const element of batch.elements) {
      if (element.role === 'fullscreen-overlay' && element.visible) {
        this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'OVERLAY_APPEARED', [element.ref], {
          coverage: element.viewportCoverage,
          benignModal: false,
        }, 'mutationObserver', batch.timestamp));
      } else if (element.role === 'bait-candidate') {
        this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'BAIT_STATE_CHANGED', [element.ref], {
          visible: element.visible,
        }, 'mutationObserver', batch.timestamp));
      }
    }
    if (batch.pageSignals.geometry.bodyScrollLocked || batch.pageSignals.geometry.htmlScrollLocked) {
      this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'SCROLL_LOCK_ON', [], {}, 'mutationObserver', batch.timestamp));
    }
    if (batch.pageSignals.mutation.rapidReinsertionDetected) {
      this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'MUTATION_BURST', [], {
        rate: batch.pageSignals.mutation.mutationRatePerSecond,
        overlayReinsertedCount: batch.pageSignals.mutation.overlayReinsertedCount,
      }, 'mutationObserver', batch.timestamp));
    }

    this.candidates.update(graph);
    await this.deps.session.persist();
    const replaying = await this.maybeReplay(graph, batch, health, epoch.url, scope);
    if (replaying) return true;
    return this.maybeRun(graph, epoch.siteKey, epoch.navigationId, health);
  }

  async onHealthSnapshot(tabId: number, frameId: number, txId: string, health: HealthVector): Promise<boolean> {
    const replay = this.pendingReplays.get(txId);
    if (replay) {
      await this.finishReplay(replay, this.enrichHealth(health, this.deps.registry.getEpoch(tabId, frameId)?.navigationId ?? ''));
      return true;
    }
    const state = this.deps.engine.getRecords().find((entry) => entry.txId === txId);
    if (!state) return false;
    const now = this.deps.registry.getCausalKey(tabId, frameId);
    if (!now) return true;
    const result = await this.deps.engine.verifyCausalExperiment(state.record.id, this.enrichHealth(health, state.navigationId), {
      ...now,
    });
    const graph = this.deps.graphs.get({
      tabId: state.tabId,
      navigationEpoch: state.navigationEpoch,
      documentId: state.documentId,
      frameId: state.frameIds[0] ?? 0,
    });
    if (graph) this.deps.beliefs.apply(graph, result.record, state.hypothesisId);
    if (graph) await this.maybeDraftOrPromote(
      graph,
      state.hypothesisId,
      state.candidate.actions,
      state.baselineFingerprint
    );
    const batch = this.lastBatches.get(`${tabId}:${frameId}:${state.documentId}`);
    const hasAnotherSafeExperiment = Boolean(
      graph && result.record.status === 'ROLLED_BACK' && this.experiments.generate(graph).some((candidate) => {
        const hypothesis = graph.hypotheses.find((item) => item.id === candidate.hypothesisRef);
        const attempted = this.attemptedMechanisms.get(graph.graphId);
        return hypothesis !== undefined && !attempted?.has(hypothesis.mechanismClass);
      })
    );
    // A failed discriminator should be followed by the next bounded causal
    // candidate, not immediately hidden by the legacy fallback. A successful
    // experiment (or exhausted causal budget) may hand off to the established
    // deterministic repair path.
    if (graph && result.record.status === 'ROLLED_BACK' && hasAnotherSafeExperiment) {
      await this.maybeRun(graph, state.siteKey, state.navigationId, this.enrichHealth(health, state.navigationId));
    } else if (batch && !hasAnotherSafeExperiment) {
      await this.deps.runFallback(tabId, state.navigationId, state.siteKey, batch);
    }
    await this.deps.session.persist();
    return true;
  }

  private enrichHealth(health: HealthVector, navigationId: string): HealthVector {
    const requests = this.deps.requestGraphs.getGraph(navigationId);
    const networkIntegrity = requests && requests.totalRequests > 0
      ? Math.max(0, 1 - requests.failedRequestsCount / requests.totalRequests)
      : 0.5;
    return { ...health, networkIntegrity, privacyPreservation: 1 };
  }

  private async maybeRun(graph: ReturnType<EventGraphStore['getOrCreate']>, siteKey: string, navigationId: string, baselineHealth: HealthVector): Promise<boolean> {
    const key = this.deps.registry.getCausalKey(graph.scope.tabId, graph.nodes[0]?.scope.frameId ?? 0);
    if (!key) return false;
    const attempted = this.attemptedMechanisms.get(graph.graphId) ?? new Set<CausalHypothesis['mechanismClass']>();
    const candidates = this.experiments.generate(graph).filter((candidate) => {
      const hypothesis = graph.hypotheses.find((item) => item.id === candidate.hypothesisRef);
      return hypothesis !== undefined && !attempted.has(hypothesis.mechanismClass);
    });
    const budget: ExperimentSelectionBudget = {
      ...graph.budgets,
      remaining: Math.max(0, graph.budgets.maxPerDocumentEpoch - graph.experiments.length),
    };
    const selected = this.selector.select(candidates, key, budget);
    if (!selected) return false;
    const selectedHypothesis = graph.hypotheses.find((item) => item.id === selected.hypothesisRef);
    if (!selectedHypothesis) return false;
    const maxId = this.deps.engine.getRecords().reduce((max, state) => {
      const n = Number(state.record.id.slice('experiment:x'.length));
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
    selected.id = `experiment:x${maxId + 1}`;
    const staged = await this.deps.engine.runCausalExperiment(selected, {
      now: key,
      siteKey,
      navigationId,
      baselineHealth,
      pageFingerprint: this.lastFingerprints.get(graph.graphId),
    });
    if (staged.record.status === 'STAGED' && staged.state) {
      attempted.add(selectedHypothesis.mechanismClass);
      this.attemptedMechanisms.set(graph.graphId, attempted);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, selected.expected.durationMs)));
      await this.deps.sendTabMessage(graph.scope.tabId, {
        v: 1,
        type: 'REQUEST_HEALTH_SNAPSHOT',
        txId: staged.state.txId,
      });
    }
    // A feasible causal candidate owns this batch even if another staged
    // transaction temporarily prevented it from starting. This keeps the
    // legacy fallback from racing and erasing the discriminating sequence; a
    // subsequent mutation/health batch retries after the active run settles.
    return true;
  }

  private fingerprint(graph: ReturnType<EventGraphStore['getOrCreate']>, batch: CausalPageObservationBatch, url: string): PageFingerprint {
    const path = (() => { try { return new URL(url).pathname.split('/').filter(Boolean)[0] ?? 'root'; } catch { return 'unknown'; } })();
    const resources = graph.nodes
      .filter((node) => node.kind.startsWith('REQUEST_'))
      .map((node) => String(node.features.hostname ?? ''))
      .filter(Boolean)
      .sort();
    // Scroll and pointer state are intervention outcomes and can legitimately
    // fluctuate while a reversible trial is settling. Detector identity uses
    // stable detector-class signals; observability guards separately require
    // mechanism-specific scroll/pointer preconditions before replay.
    const detectorIdentityTypes = batch.pageSignals.suspectedDetectorTypes
      .filter((type) => type === 'SEMANTIC_PROMPT' || type === 'FULLSCREEN_GATE')
      .sort();
    return createPageFingerprint({
      originHash: graph.scope.originHash,
      topLevelPathClass: path,
      detectorFeatureHash: hashOrigin(detectorIdentityTypes.join('|')),
      relevantResourceSetHash: hashOrigin(resources.join('|')),
      structuralFeatureHash: hashOrigin(batch.elements.map((element) => `${element.role}:${Math.round(element.viewportCoverage * 10)}`).sort().join('|')),
      createdWallMs: Date.now(),
    });
  }

  private remapActions(actions: StrategyAction[], batch: CausalPageObservationBatch): StrategyAction[] | null {
    const overlay = batch.elements.find((element) => element.role === 'fullscreen-overlay' && element.visible)?.ref;
    const bait = batch.elements.find((element) => element.role === 'bait-candidate')?.ref;
    const out: StrategyAction[] = [];
    for (const action of actions) {
      if (!action.type.startsWith('DOM_')) return null;
      if (action.type === 'DOM_REMOVE_OVERLAY' || action.type === 'DOM_HIDE' || action.type === 'DOM_COLLAPSE') {
        if (!overlay) return null;
        out.push({ ...action, id: `${action.id}_replay_${Date.now()}`, targetRef: overlay });
      } else if (action.type === 'DOM_PRESERVE_BAIT_CANDIDATE') {
        if (!bait) return null;
        out.push({ ...action, id: `${action.id}_replay_${Date.now()}`, targetRef: bait });
      } else {
        out.push({ ...action, id: `${action.id}_replay_${Date.now()}` });
      }
    }
    return out;
  }

  /**
   * A recipe fingerprint is meaningful only after the technical signals that
   * identify its mechanism are observable. Early content-script batches can
   * contain the bait node before the detector-created overlay/scroll state;
   * treating that partial snapshot as an identity mismatch would invalidate a
   * valid recipe merely because of event timing.
   */
  private recipeBaselineObservable(
    mechanism: string,
    batch: CausalPageObservationBatch
  ): boolean {
    const hasVisibleOverlay = batch.elements.some(
      (element) => element.role === 'fullscreen-overlay' && element.visible
    );
    const hasBait = batch.elements.some((element) => element.role === 'bait-candidate');
    switch (mechanism) {
      case 'BAIT_VISIBILITY_PROBE':
        return hasBait && hasVisibleOverlay;
      case 'OVERLAY_REINSERTION':
        return hasVisibleOverlay && batch.pageSignals.mutation.rapidReinsertionDetected;
      case 'SCROLL_LOCK_REACTION':
        return hasVisibleOverlay && (
          batch.pageSignals.geometry.bodyScrollLocked
          || batch.pageSignals.geometry.htmlScrollLocked
        );
      default:
        return true;
    }
  }

  private async maybeReplay(
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    batch: CausalPageObservationBatch,
    baseline: HealthVector,
    url: string,
    scope: CausalDocumentKey
  ): Promise<boolean> {
    if (Array.from(this.pendingReplays.values()).some((pending) => pending.tabId === scope.tabId)) return true;
    const records = await this.deps.recipeStore.getByOriginHash(graph.scope.originHash);
    const record = records.find((item) => item.lifecycle !== 'INVALIDATED' && item.actions?.length);
    if (!record?.actions) return false;
    if (!this.recipeBaselineObservable(record.recipe.causalSupport.hypothesisClass, batch)) {
      // The document is still assembling the causal baseline. Abstain until a
      // later observation instead of applying or invalidating on partial data.
      return true;
    }
    const fp = this.fingerprint(graph, batch, url);
    const fingerprint = checkFingerprint(
      { originHash: record.recipe.originHash, ...record.recipe.fingerprintConstraints },
      fp
    );
    if (!fingerprint.ok) {
      if (isIdentityMismatch(fingerprint.kind) || fingerprint.kind === 'MISSING_CONSTRAINT') {
        await this.deps.recipeStore.save({
          ...record,
          lifecycle: 'INVALIDATED',
          invalidationReason: fingerprint.kind,
          updatedWallMs: Date.now(),
        });
        return false;
      }
      // Resource/path ambiguity is not identity proof. Abstain without applying
      // the recipe or launching a competing experiment in this document.
      return true;
    }
    const applicationKey = `${record.recipe.id}:${scope.documentId}`;
    if (this.completedRecipeApplications.has(applicationKey)) return true;
    const actions = this.remapActions(record.actions, batch);
    if (!actions) return false;
    const keepAppliedOnSuccess = record.lifecycle === 'RECIPE_SAFE';
    const replayActions = keepAppliedOnSuccess
      ? actions.map((action, index) => ({
          ...action,
          id: `causal_recipe_${record.recipe.id}_${scope.documentId}_${index}`,
        }))
      : actions;
    const txId = `causal_replay_${record.recipe.id}_${Date.now()}`;
    const applied: StrategyAction[] = [];
    try {
      for (const action of replayActions) {
        await this.deps.sendTabMessage(scope.tabId, {
          v: 1, type: 'APPLY_DOM_ACTION', txId, documentId: scope.documentId, payload: action,
        });
        applied.push(action);
      }
    } catch {
      for (const action of applied.reverse()) {
        await this.deps.sendTabMessage(scope.tabId, {
          v: 1, type: 'ROLLBACK_DOM_ACTION', txId, documentId: scope.documentId, actionId: action.id,
        }).catch(() => {});
      }
      return false;
    }
    const pending: PendingReplay = {
      txId, tabId: scope.tabId, documentId: scope.documentId, frameId: scope.frameId,
      baseline, fingerprint: fp, recordId: record.recipe.id, applied,
      applicationKey, keepAppliedOnSuccess,
    };
    this.pendingReplays.set(txId, pending);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await this.deps.sendTabMessage(scope.tabId, {
      v: 1, type: 'REQUEST_HEALTH_SNAPSHOT', txId, documentId: scope.documentId,
    }).catch(async () => this.finishReplay(pending, baseline));
    return true;
  }

  private async finishReplay(pending: PendingReplay, post: HealthVector): Promise<void> {
    this.pendingReplays.delete(pending.txId);
    const stored = await this.deps.recipeStore.getRecipe(pending.recordId);
    if (!stored) return;
    const verification = verifyHealthOutcome(pending.baseline, post);
    let rollbackOk = true;
    if (!pending.keepAppliedOnSuccess || !verification.success) {
      for (const action of [...pending.applied].reverse()) {
        try {
          await this.deps.sendTabMessage(pending.tabId, {
            v: 1, type: 'ROLLBACK_DOM_ACTION', txId: pending.txId,
            documentId: pending.documentId, actionId: action.id,
          });
        } catch { rollbackOk = false; }
      }
    }
    const replayed = this.deps.promotion.replay(stored.recipe, pending.fingerprint, verification.scoreDelta, verification.success);
    const seq = (stored.evidence ?? []).reduce((max, item) => {
      const n = Number(item.id.slice('experiment:x'.length));
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0) + 1;
    const evidence = [...(stored.evidence ?? []), {
      id: `experiment:x${seq}` as const,
      candidateHash: hashOrigin(pending.txId), startedWallMs: Date.now() - 200,
      completedWallMs: Date.now(), status: verification.success ? 'COMMITTED' as const : 'ROLLED_BACK' as const,
      preHealth: this.toCompact(pending.baseline), postHealth: this.toCompact(post),
      healthDelta: verification.scoreDelta, observedRefs: [...stored.recipe.actionRefs],
      policyDecisionId: `policy:${stored.recipe.id}`, transactionId: pending.txId,
      rollbackVerified: pending.keepAppliedOnSuccess ? false : rollbackOk,
      epochStillFresh: this.deps.registry.getCausalKey(pending.tabId, pending.frameId)?.documentId === pending.documentId,
      visitId: pending.documentId, fingerprintHash: fingerprintEvidenceHash(pending.fingerprint), replay: true,
      privacyScore: post.privacyPreservation ?? 0.5,
    }];
    let lifecycle: CausalRecipeLifecycle = replayed.lifecycle === 'INVALIDATED'
      ? 'INVALIDATED'
      : stored.lifecycle === 'RECIPE_SAFE' || replayed.lifecycle === 'RECIPE_SAFE'
        ? 'RECIPE_SAFE'
        : replayed.recipe.causalSupport.stableReplays >= 1 ? 'CONFIRMED' : stored.lifecycle;
    let recipe = replayed.recipe;
    if (lifecycle !== 'INVALIDATED' && !pending.keepAppliedOnSuccess) {
      const mechanism = stored.recipe.causalSupport.hypothesisClass;
      if (PROMOTABLE_MECHANISMS.has(mechanism as CausalHypothesis['mechanismClass'])) {
        const hypothesis: CausalHypothesis = {
          id: 'hypothesis:h0',
          causeRefs: [...stored.recipe.actionRefs],
          outcome: mechanism === 'BAIT_VISIBILITY_PROBE' || mechanism === 'OVERLAY_REINSERTION'
            ? 'ANTI_BLOCK_REACTION'
            : 'PAGE_BREAKAGE',
          mechanismClass: mechanism as CausalHypothesis['mechanismClass'],
          prior: stored.recipe.causalSupport.posterior,
          posterior: stored.recipe.causalSupport.posterior,
          confoundingRisk: 'LOW',
          status: 'SUPPORTED',
          createdFrom: [...stored.recipe.actionRefs],
          updatedByExperiments: evidence.map((item) => item.id),
        };
        const promoted = this.deps.promotion.evaluate({
          hypothesis,
          fingerprint: pending.fingerprint,
          fingerprintConstraints: stored.recipe.fingerprintConstraints,
          actionRefs: [...stored.recipe.actionRefs],
          actions: stored.actions ?? [],
          expectedHealthDelta: stored.recipe.expectedHealthDelta,
          minPrivacyScore: Math.min(...evidence.map((item) => item.privacyScore ?? 0.5), 1),
          rollbackPlanRef: stored.recipe.rollbackPlanRef,
          preconditions: [...stored.recipe.preconditions],
          stableReplays: replayed.recipe.causalSupport.stableReplays,
          experiments: evidence,
          existingRecipeId: stored.recipe.id,
        });
        if (promoted.pass) {
          recipe = promoted.recipe;
          lifecycle = 'RECIPE_SAFE';
        }
      }
    }
    await this.deps.recipeStore.save({
      ...stored,
      recipe,
      lifecycle,
      evidence,
      invalidationReason: lifecycle === 'INVALIDATED' ? 'REPLAY_HEALTH_OR_ROLLBACK' : undefined,
      updatedWallMs: Date.now(),
    });
    this.completedRecipeApplications.add(pending.applicationKey);
    if (lifecycle !== 'INVALIDATED' && stored.actions) {
      const key = this.deps.registry.getCausalKey(pending.tabId, pending.frameId);
      const graph = key ? this.deps.graphs.get(key) : undefined;
      const hypothesis = graph?.hypotheses.find(
        (item) => item.mechanismClass === stored.recipe.causalSupport.hypothesisClass && item.status === 'SUPPORTED'
      );
      if (graph && hypothesis) await this.maybeDraftOrPromote(graph, hypothesis.id, stored.actions);
    }
  }

  private toCompact(health: HealthVector): HealthVectorCompact {
    return {
      contentAccess: health.contentAvailability, interaction: health.interaction,
      scrollability: health.scrollability, visualObstruction: health.visualObstruction,
      mutationStability: health.mutationStability, networkIntegrity: health.networkIntegrity ?? 0.5,
      privacyPreservation: health.privacyPreservation ?? 0.5, confidence: health.confidence,
    };
  }

  private async maybeDraftOrPromote(
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    hypothesisId: `hypothesis:h${number}`,
    actions: StrategyAction[],
    baselineFingerprint?: PageFingerprint
  ): Promise<void> {
    const hypothesis = graph.hypotheses.find((item) => item.id === hypothesisId);
    if (!hypothesis || hypothesis.status !== 'SUPPORTED') return;
    const existing = (await this.deps.recipeStore.getByOriginHash(graph.scope.originHash))
      .find((item) => item.recipe.causalSupport.hypothesisClass === hypothesis.mechanismClass);
    const lastHealth = graph.nodes.filter((node) => node.kind === 'HEALTH_SNAPSHOT').at(-1);
    const fingerprint = baselineFingerprint ?? this.lastFingerprints.get(graph.graphId);
    if (!fingerprint) return;
    const experiments = this.deps.engine.getRecords()
      .filter((state) => state.hypothesisId === hypothesisId && state.record.status === 'COMMITTED')
      .map((state) => state.record);
    const input: PromotionEvaluateInput = {
      hypothesis, fingerprint, actionRefs: [...hypothesis.causeRefs], actions,
      // A DOM-only recipe must not depend on webRequest timing. Resource-set
      // identity is required only for recipes that actually mutate network
      // behavior; origin/path/detector/structure remain mandatory here.
      fingerprintConstraints: {
        originHash: fingerprint.originHash,
        topLevelPathClass: fingerprint.topLevelPathClass,
        detectorFeatureHash: fingerprint.detectorFeatureHash,
        structuralFeatureHash: fingerprint.structuralFeatureHash,
        ...(actions.some((action) => action.type.startsWith('NET_'))
          ? { relevantResourceSetHash: fingerprint.relevantResourceSetHash }
          : {}),
      },
      expectedHealthDelta: typeof lastHealth?.features.delta === 'number' ? Math.abs(lastHealth.features.delta) : 0.1,
      minPrivacyScore: Math.min(...experiments.map((record) => record.privacyScore ?? 0.5), 1),
      rollbackPlanRef: `rollback:${hypothesis.mechanismClass}`,
      stableReplays: existing?.recipe.causalSupport.stableReplays ?? 0,
      experiments: [...experiments, ...(existing?.evidence ?? [])], existingRecipeId: existing?.recipe.id,
    };
    const promoted = this.deps.promotion.evaluate(input);
    if (promoted.pass) {
      await this.deps.recipeStore.save({ recipe: promoted.recipe, lifecycle: 'RECIPE_SAFE', actions, evidence: [...input.experiments], updatedWallMs: Date.now() });
    } else if (!existing) {
      const draft = this.deps.promotion.compileDraft(input);
      if (draft) await this.deps.recipeStore.save({ recipe: draft, lifecycle: 'DRAFT', actions, evidence: experiments, updatedWallMs: Date.now() });
    }
  }
}
