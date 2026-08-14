import { calculateHealthVector } from '../../core/health/scorer';
import { NavigationRegistry } from '../../core/navigation/registry';
import { normalizeUrlForTelemetry } from '../../core/network/normalize-url';
import { RequestGraphManager } from '../../core/network/request-graph';
import {
  CausalDocumentKey,
  CausalHypothesis,
  createEventId,
  EventNode,
  ExperimentRecord,
  hashOrigin,
  HealthVectorCompact,
  OpaqueRef,
} from '../../shared/causal/events';
import { ExperimentSelectionBudget } from '../../shared/causal/experiments';
import { CausalPageObservationBatch, HealthVector, NavigationTargetObservation, StrategyAction, UserIntentEnvelope } from '../../shared/types';
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
import { PrimitiveOutcomeVerifierRegistry } from '../autonomy/outcome-verifier';
import { generateHypothesisLattice } from '../autonomy/hypothesis-lattice';
import { AutonomousExperiment, AutonomousExperimentLoop } from '../autonomy/saei';
import { AutonomyPendingState, AutonomySessionRepository, AutonomySessionSnapshot } from '../autonomy/session';
import { PrimitiveExecutorRegistry, primitiveRecipeActions } from '../autonomy/executor-registry';

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
  primitiveExecutors?: PrimitiveExecutorRegistry;
  autonomySession?: AutonomySessionRepository;
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

interface PendingAutonomy extends AutonomyPendingState {
  execution: NonNullable<AutonomyPendingState['execution']>;
  fingerprint?: PageFingerprint;
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
  private readonly autonomyLoops = new Map<string, AutonomousExperimentLoop>();
  private readonly pendingAutonomy = new Map<string, PendingAutonomy>();
  private readonly pendingNavigationEvidence = new Map<number, { ref: OpaqueRef; kind: EventNode['kind']; features: EventNode['features'] }>();
  private readonly handledNavigationRefs = new Set<string>();
  private readonly outcomeVerifiers = new PrimitiveOutcomeVerifierRegistry();

  constructor(private readonly deps: CausalOrchestratorDeps) {
    this.normalizer = new EventNormalizer(deps.registry);
  }

  async restoreAutonomy(snapshot?: AutonomySessionSnapshot): Promise<void> {
    if (!snapshot) return;
    this.autonomyLoops.clear();
    this.pendingAutonomy.clear();
    for (const [graphId, state] of snapshot.loops) {
      const graph = this.deps.graphs.getAll().find((item) => item.graphId === graphId);
      const fingerprint = this.lastFingerprints.get(graphId);
      const loop = new AutonomousExperimentLoop(undefined, undefined, state);
      loop.restore({
        events: graph?.nodes ?? [],
        health: {
          pageHealth: 0.5,
          contentHealth: 0.5,
          interactionHealth: 0.5,
          privacyHealth: 1,
          reactionResolved: false,
        },
        fingerprintHash: fingerprint ? fingerprintEvidenceHash(fingerprint) : `restored:${graphId}`,
        knownRecipe: false,
        developerHint: false,
      }, state);
      this.autonomyLoops.set(graphId, loop);
    }
    for (const pending of snapshot.pending ?? []) {
      if (!pending.execution || !pending.experiment) continue;
      this.deps.primitiveExecutors?.hydrate(pending.execution);
      this.pendingAutonomy.set(pending.txId, pending);
      const live = this.deps.registry.getEpoch(pending.tabId, pending.frameId);
      if (!live || live.documentId !== pending.documentId) {
        await this.deps.primitiveExecutors?.rollback(pending.txId);
        this.pendingAutonomy.delete(pending.txId);
        continue;
      }
      await this.deps.sendTabMessage(pending.tabId, {
        v: 1,
        type: 'REQUEST_HEALTH_SNAPSHOT',
        txId: pending.txId,
        documentId: pending.documentId,
      }).catch(async () => {
        await this.deps.primitiveExecutors?.rollback(pending.txId);
        this.pendingAutonomy.delete(pending.txId);
      });
    }
    await this.persistAutonomySession();
  }

  async onNavigationTargetClassification(
    target: NavigationTargetObservation,
    classification: { disposition: string; confidence: number; evidence: string[] }
  ): Promise<void> {
    if (classification.disposition === 'OBSERVE_ONLY') return;
    const scope = this.deps.registry.getCausalKey(target.sourceTabId, target.sourceFrameId);
    const epoch = this.deps.registry.getEpoch(target.sourceTabId, target.sourceFrameId);
    if (!scope || !epoch) return;
    const graph = this.deps.graphs.get(scope);
    if (!graph) return;
    const baseline = this.previousHealth.get(`${target.sourceTabId}:${target.sourceFrameId}:${scope.navigationEpoch}:${scope.documentId}`)
      ?? this.defaultHealth();
    await this.maybeRun(graph, epoch.siteKey, epoch.navigationId, baseline, true);
  }

  async onNavigation(raw: RawNavigationEvent): Promise<void> {
    const node = this.normalizer.normalizeNavigation(raw);
    if (!node) return;
    const key = this.deps.registry.getCausalKey(raw.tabId, raw.frameId);
    if (!key) return;
    const graph = this.deps.graphs.getOrCreate(key, node.scope.originHash);
    this.deps.graphs.append(node);
    const carried = raw.frameId === 0 ? this.pendingNavigationEvidence.get(raw.tabId) : undefined;
    if (carried) {
      this.deps.graphs.append(nowNode(
        key,
        node.scope.originHash,
        carried.kind,
        [carried.ref],
        { ...carried.features, carriedAcrossDocument: true },
        'navigationIntent',
        raw.timeStamp ?? Date.now()
      ));
      this.pendingNavigationEvidence.delete(raw.tabId);
    }
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
    if (raw.type === 'error') {
      this.deps.graphs.append(nowNode(key, graph.scope.originHash, 'NETWORK_PROBE_REACTION', node.refs, {
        resourceType: raw.resourceType ?? null,
        errorClass: raw.error ? 'REQUEST_ERROR' : 'UNKNOWN',
      }, 'webRequest', raw.timeStamp ?? Date.now()));
    }
    this.candidates.update(graph);
    await this.deps.session.persist();
  }

  async onIntentEnvelope(tabId: number, frameId: number, envelope: UserIntentEnvelope): Promise<void> {
    const epoch = this.deps.registry.getEpoch(tabId, frameId);
    const scope = this.deps.registry.getCausalKey(tabId, frameId);
    if (!epoch || !scope) return;
    const graph = this.deps.graphs.getOrCreate(scope, hashOrigin(epoch.origin));
    this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'USER_INTENT', [envelope.ref, envelope.elementRef], {
      elementRole: envelope.elementRole,
      destinationClass: envelope.declaredDestinationClass,
      expectedNavigation: envelope.navigationReasonablyExpected,
      interactionType: envelope.interactionType,
      button: envelope.button,
    }, 'navigationIntent', envelope.capturedWallMs));
    graph.hypotheses = generateHypothesisLattice(graph.nodes, graph.hypotheses);
    await this.deps.session.persist();
  }

  async onNavigationTarget(target: NavigationTargetObservation): Promise<void> {
    const epoch = this.deps.registry.getEpoch(target.sourceTabId, target.sourceFrameId);
    const scope = this.deps.registry.getCausalKey(target.sourceTabId, target.sourceFrameId);
    if (!epoch || !scope) return;
    const graph = this.deps.graphs.getOrCreate(scope, hashOrigin(epoch.origin));
    const expectedNewContext = target.expectedNewContext === true
      && target.destinationMatch === true
      && target.extraTarget !== true;
    if (expectedNewContext) {
      await this.deps.session.persist();
      return;
    }
    const kind: EventNode['kind'] = target.redirectCount > 1
      ? 'SUSPICIOUS_REDIRECT_CHAIN'
      : target.riskSignals.includes('NO_RECENT_INTENT')
        || target.riskSignals.includes('UNEXPECTED_AFTER_GESTURE')
        || target.riskSignals.includes('EXTRA_TARGET')
        || target.riskSignals.includes('DESTINATION_MISMATCH')
        ? 'UNEXPECTED_NAV_TARGET'
        : 'POPUP_OR_POPUNDER';
    this.deps.graphs.append(nowNode(scope, graph.scope.originHash, kind, [target.ref, ...(target.recentIntentRef ? [target.recentIntentRef] : [])], {
      destinationClass: target.destinationClass,
      foregroundState: target.foregroundState,
      openerRelationship: target.openerRelationship,
      redirectCount: target.redirectCount,
      recentIntentAgeMs: target.recentIntentAgeMs ?? null,
      riskSignalCount: target.riskSignals.length,
    }, 'navigationIntent', target.capturedWallMs));
    graph.hypotheses = generateHypothesisLattice(graph.nodes, graph.hypotheses);
    this.pendingNavigationEvidence.set(target.sourceTabId, {
      ref: target.ref,
      kind,
      features: {
        destinationClass: target.destinationClass,
        foregroundState: target.foregroundState,
        openerRelationship: target.openerRelationship,
        redirectCount: target.redirectCount,
        riskSignalCount: target.riskSignals.length,
      },
    });
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

    const carriedNavigation = [...this.pendingAutonomy.values()].find((pending) =>
      pending.tabId === tabId
      && pending.frameId === frameId
      && pending.documentId !== scope.documentId
      && pending.experiment.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
    );
    if (carriedNavigation) await this.finishAutonomous(carriedNavigation, health);

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
        if (element.visible) {
          this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'VISIBLE_AD_CANDIDATE', [element.ref], {
            coverage: element.viewportCoverage,
          }, 'mutationObserver', batch.timestamp));
        }
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
      this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'REPEATED_REINSERTION', [], {
        count: batch.pageSignals.mutation.overlayReinsertedCount,
      }, 'mutationObserver', batch.timestamp));
    }

    const categories = batch.pageSignals.semantic.categories ?? [];
    if (categories.includes('ANTI_BLOCK_INSTRUCTION')) {
      this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'ANTI_BLOCK_REACTION', [], {
        semanticCategory: 'ANTI_BLOCK_INSTRUCTION',
        confidence: batch.pageSignals.semantic.confidenceScore,
      }, 'semanticObserver', batch.timestamp));
      this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'SEMANTIC_GATE', [], {
        category: 'ANTI_BLOCK_INSTRUCTION',
      }, 'semanticObserver', batch.timestamp));
    }
    if (categories.includes('PLAYBACK_GATE')) {
      this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'PLAYBACK_OBSTRUCTED', [], {
        semanticCategory: 'PLAYBACK_GATE',
      }, 'semanticObserver', batch.timestamp));
    }
    if (categories.includes('INTERACTION_DENIAL') || batch.pageSignals.interaction.pointerEventsSuppressed) {
      this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'INTERACTION_DENIED', [], {
        pointerSuppressed: batch.pageSignals.interaction.pointerEventsSuppressed,
      }, 'semanticObserver', batch.timestamp));
    }
    if (batch.pageSignals.anomalyCategories?.includes('UNKNOWN_REACTION')) {
      this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'UNKNOWN_REACTION', [], {
        categoryCount: batch.pageSignals.anomalyCategories.length,
      }, 'semanticObserver', batch.timestamp));
    }
    if (batch.intents) {
      for (const intent of batch.intents) {
        this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'USER_INTENT', [intent.ref, intent.elementRef], {
          elementRole: intent.elementRole,
          destinationClass: intent.declaredDestinationClass,
          expectedNavigation: intent.navigationReasonablyExpected,
        }, 'navigationIntent', intent.capturedWallMs));
      }
    }

    this.candidates.update(graph);
    const hasDeterministicCausalExperiment = this.experiments.generate(graph).length > 0;
    // Preserve the established deterministic path whenever it already has a
    // valid intervention. SAEI expands the lattice only for unresolved cases.
    if (!hasDeterministicCausalExperiment) {
      graph.hypotheses = generateHypothesisLattice(graph.nodes, graph.hypotheses);
    }
    await this.deps.session.persist();
    const replaying = await this.maybeReplay(graph, batch, health, epoch.url, scope);
    if (replaying) return true;
    if (!hasDeterministicCausalExperiment) {
      const autonomousResult = await this.maybeRun(graph, epoch.siteKey, epoch.navigationId, health);
      if (autonomousResult) return true;
      const fallbackResult = await this.deps.runFallback(tabId, epoch.navigationId, epoch.siteKey, batch.pageSignals);
      if (fallbackResult) return true;
    }
    return this.maybeRun(graph, epoch.siteKey, epoch.navigationId, health);
  }

  async onHealthSnapshot(tabId: number, frameId: number, txId: string, health: HealthVector): Promise<boolean> {
    const replay = this.pendingReplays.get(txId);
    if (replay) {
      await this.finishReplay(replay, this.enrichHealth(health, this.deps.registry.getEpoch(tabId, frameId)?.navigationId ?? ''));
      return true;
    }
    const autonomous = this.pendingAutonomy.get(txId);
    if (autonomous) {
      await this.finishAutonomous(autonomous, this.enrichHealth(health, autonomous.navigationId));
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

  private defaultHealth(): HealthVector {
    return {
      antiBlockReaction: 0,
      contentAvailability: 1,
      interaction: 1,
      scrollability: 1,
      navigationHealth: 1,
      visualObstruction: 0,
      mutationStability: 1,
      networkIntegrity: 1,
      privacyPreservation: 1,
      confidence: 0.5,
    };
  }

  private async persistAutonomySession(): Promise<void> {
    if (!this.deps.autonomySession) return;
    await this.deps.autonomySession.persist(this.autonomyLoopsToState(), [...this.pendingAutonomy.values()]);
  }

  private autonomyLoopsToState(): Map<string, ReturnType<AutonomousExperimentLoop['snapshot']>> {
    return new Map([...this.autonomyLoops.entries()].map(([key, loop]) => [key, loop.snapshot()]));
  }

  private async maybeRun(
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    siteKey: string,
    navigationId: string,
    baselineHealth: HealthVector,
    forceAutonomous = false
  ): Promise<boolean> {
    const key = this.deps.registry.getCausalKey(graph.scope.tabId, graph.nodes[0]?.scope.frameId ?? 0);
    if (!key) return false;
    if (graph.nodes.some((node) =>
      (node.kind === 'UNEXPECTED_NAV_TARGET' || node.kind === 'POPUP_OR_POPUNDER')
      && node.refs.some((ref) => this.handledNavigationRefs.has(ref))
    )) return true;
    if ([...this.pendingAutonomy.values()].some((pending) => pending.graphId === graph.graphId)) return true;
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
    const autonomousSelection = forceAutonomous || !selected ? this.autonomousSelection(graph, baselineHealth) : null;
    if (autonomousSelection && this.deps.primitiveExecutors) {
      return this.stageAutonomousExperiment(graph, siteKey, navigationId, baselineHealth, autonomousSelection.experiment);
    }
    const selectedExperiment = selected;
    if (!selectedExperiment) return false;
    const selectedHypothesis = graph.hypotheses.find((item) => item.id === selectedExperiment.hypothesisRef);
    if (!selectedHypothesis) return false;
    const maxId = this.deps.engine.getRecords().reduce((max, state) => {
      const n = Number(state.record.id.slice('experiment:x'.length));
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
    selectedExperiment.id = `experiment:x${maxId + 1}`;
    const staged = await this.deps.engine.runCausalExperiment(selectedExperiment, {
      now: key,
      siteKey,
      navigationId,
      baselineHealth,
      pageFingerprint: this.lastFingerprints.get(graph.graphId),
    });
    if (staged.record.status === 'STAGED' && staged.state) {
      if (!autonomousSelection) attempted.add(selectedHypothesis.mechanismClass);
      this.attemptedMechanisms.set(graph.graphId, attempted);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, selectedExperiment.expected.durationMs)));
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

  private autonomousSelection(
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    baselineHealth: HealthVector
  ): { experiment: AutonomousExperiment; hypothesis: CausalHypothesis } | null {
    const loop = this.autonomyLoops.get(graph.graphId) ?? new AutonomousExperimentLoop();
    const observation = {
      events: graph.nodes,
      health: {
        pageHealth: compactScore(baselineHealth),
        contentHealth: baselineHealth.contentAvailability,
        interactionHealth: baselineHealth.interaction,
        privacyHealth: baselineHealth.privacyPreservation ?? 1,
        reactionResolved: baselineHealth.antiBlockReaction < 0.2,
      },
      fingerprintHash: fingerprintEvidenceHash(this.lastFingerprints.get(graph.graphId) ?? createPageFingerprint({
        originHash: graph.scope.originHash,
        topLevelPathClass: 'unknown',
        detectorFeatureHash: 'unknown',
        relevantResourceSetHash: 'unknown',
        structuralFeatureHash: 'unknown',
      })),
      knownRecipe: false,
      developerHint: false,
    };
    if (!this.autonomyLoops.has(graph.graphId)) {
      loop.start(observation);
      this.autonomyLoops.set(graph.graphId, loop);
    } else if (loop.snapshot().status === 'EXPLORING') {
      loop.restore(observation, loop.snapshot());
    }
    const experiment = loop.nextExperiment();
    if (!experiment) return null;
    const currentOpaqueRefs = graph.nodes.flatMap((node) => node.refs)
      .filter((ref) => ref.startsWith('element:') || ref.startsWith('request:') || ref.startsWith('navigation:'));
    experiment.opaqueRefs = [...new Set([...experiment.opaqueRefs, ...currentOpaqueRefs])];
    const hypothesis = graph.hypotheses.find((item) => item.id === experiment.hypothesisId);
    if (!hypothesis) return null;
    return { experiment, hypothesis };
  }

  private async stageAutonomousExperiment(
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    siteKey: string,
    navigationId: string,
    baselineHealth: HealthVector,
    experiment: AutonomousExperiment
  ): Promise<boolean> {
    const executors = this.deps.primitiveExecutors;
    const loop = this.autonomyLoops.get(graph.graphId);
    if (!executors || !loop) return false;
    const currentOpaqueRefs = graph.nodes.flatMap((node) => node.refs)
      .filter((ref) => ref.startsWith('element:') || ref.startsWith('request:') || ref.startsWith('navigation:'));
    experiment.opaqueRefs = [...new Set([...experiment.opaqueRefs, ...currentOpaqueRefs])];
    const frameId = graph.nodes.at(-1)?.scope.frameId ?? 0;
    const txId = `autonomy_${graph.scope.tabId}_${graph.scope.navigationEpoch}_${Date.now()}`;
    const staged = await executors.stage({
      txId,
      tabId: graph.scope.tabId,
      frameId,
      documentId: graph.scope.documentId,
      primitiveId: experiment.primitiveId,
      opaqueRefs: [...experiment.opaqueRefs],
      evidence: [],
    }).catch((error: unknown) => ({
      ok: false as const,
      gap: { code: 'EXECUTOR_ERROR' as const, reason: error instanceof Error ? error.message : String(error) },
    }));

    if (!staged.ok) {
      loop.recordCapabilityGap(experiment, staged.gap.code, staged.gap.reason);
      await this.persistAutonomySession();
      const next = loop.nextExperiment();
      const nextHypothesis = next ? graph.hypotheses.find((item) => item.id === next.hypothesisId) : undefined;
      if (next && nextHypothesis) {
        return this.stageAutonomousExperiment(graph, siteKey, navigationId, baselineHealth, next);
      }
      return false;
    }

    const pending: PendingAutonomy = {
      txId,
      graphId: graph.graphId,
      experiment,
      execution: staged.record,
      baseline: baselineHealth,
      fingerprint: this.lastFingerprints.get(graph.graphId),
      siteKey,
      navigationId,
      frameId,
      documentId: graph.scope.documentId,
      tabId: graph.scope.tabId,
    };
    this.pendingAutonomy.set(txId, pending);
    await this.persistAutonomySession();
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, experiment.durationMs)));
    if (!this.pendingAutonomy.has(txId)) return true;
    await this.deps.sendTabMessage(graph.scope.tabId, {
      v: 1,
      type: 'REQUEST_HEALTH_SNAPSHOT',
      txId,
      documentId: graph.scope.documentId,
    });
    return true;
  }

  private async finishAutonomous(
    pending: PendingAutonomy,
    postHealth: HealthVector
  ): Promise<void> {
    const executors = this.deps.primitiveExecutors;
    const verification = this.outcomeVerifiers.verify(
      pending.experiment.primitiveId,
      pending.baseline,
      postHealth,
      {
        targetClosed: pending.execution.closedTargetUrl !== undefined,
        redirectStopped: pending.execution.navigationRef !== undefined,
      }
    );
    const rollback = verification.success
      ? { ok: true, errors: [] as string[] }
      : await executors?.rollback(pending.txId) ?? { ok: false, errors: ['executor unavailable'] };
    if (verification.success) await executors?.commit(pending.txId);
    if (verification.success && pending.experiment.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET' && pending.execution.navigationRef) {
      this.handledNavigationRefs.add(pending.execution.navigationRef);
    }

    const record: ExperimentRecord = {
      id: pending.experiment.id,
      candidateHash: hashOrigin(`${pending.graphId}:${pending.experiment.primitiveId}`),
      startedWallMs: pending.execution.startedWallMs,
      completedWallMs: Date.now(),
      status: verification.success ? 'COMMITTED' : 'ROLLED_BACK',
      preHealth: this.toCompact(pending.baseline),
      postHealth: this.toCompact(postHealth),
      healthDelta: verification.scoreDelta,
      observedRefs: pending.experiment.opaqueRefs as OpaqueRef[],
      policyDecisionId: `policy:autonomy:${pending.experiment.primitiveId}`,
      transactionId: pending.txId,
      rollbackVerified: rollback.ok,
      epochStillFresh: pending.experiment.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
        || this.deps.registry.getEpoch(pending.tabId, pending.frameId)?.documentId === pending.documentId,
      visitId: pending.documentId,
      fingerprintHash: pending.fingerprint ? fingerprintEvidenceHash(pending.fingerprint) : undefined,
      privacyScore: postHealth.privacyPreservation ?? 1,
      primitiveId: pending.experiment.primitiveId,
      ...(rollback.ok ? {} : { capabilityGapCode: 'ROLLBACK_NOT_RELIABLE' }),
    };
    const graph = this.deps.graphs.get({
      tabId: pending.tabId,
      navigationEpoch: this.deps.registry.getEpoch(pending.tabId, pending.frameId)?.navigationEpoch ?? 0,
      documentId: pending.documentId,
      frameId: pending.frameId,
    }) ?? this.deps.graphs.getAll().find((item) => item.graphId === pending.graphId);
    const loop = this.autonomyLoops.get(pending.graphId);
    if (graph) {
      this.deps.beliefs.apply(graph, record, pending.experiment.hypothesisId);
      const hypothesis = graph.hypotheses.find((item) => item.id === pending.experiment.hypothesisId);
      if (hypothesis && verification.success) {
        await this.promoteAutonomous(graph, hypothesis, pending, record);
      }
    }
    loop?.recordOutcome(pending.experiment, {
      resolved: verification.success,
      pageHealthy: postHealth.interaction >= 0.7 && postHealth.scrollability >= 0.7,
      healthDelta: verification.scoreDelta,
      durationMs: Date.now() - pending.execution.startedWallMs,
    });
    this.pendingAutonomy.delete(pending.txId);
    await executors?.discard(pending.txId);
    await this.persistAutonomySession();
    if (!verification.success && graph && loop?.nextExperiment()) {
      const epoch = this.deps.registry.getEpoch(pending.tabId, pending.frameId);
      if (epoch) await this.maybeRun(graph, epoch.siteKey, epoch.navigationId, postHealth, true);
    }
  }

  private async promoteAutonomous(
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    hypothesis: CausalHypothesis,
    pending: PendingAutonomy,
    record: ExperimentRecord
  ): Promise<void> {
    const fingerprint = pending.fingerprint ?? this.lastFingerprints.get(graph.graphId);
    const actions = primitiveRecipeActions(pending.experiment.primitiveId, pending.experiment.opaqueRefs);
    if (!fingerprint || actions.length === 0) return;
    const existing = (await this.deps.recipeStore.getByOriginHash(fingerprint.originHash))
      .find((item) => item.recipe.causalSupport.hypothesisClass === hypothesis.mechanismClass);
    const evidence = [...(existing?.evidence ?? []), record];
    const input: PromotionEvaluateInput = {
      hypothesis,
      fingerprint,
      fingerprintConstraints: existing?.recipe.fingerprintConstraints,
      actionRefs: pending.experiment.opaqueRefs as OpaqueRef[],
      actions: existing?.actions ? [...existing.actions] : actions,
      expectedHealthDelta: record.healthDelta ?? 0,
      minPrivacyScore: record.privacyScore ?? 1,
      rollbackPlanRef: `rollback:${pending.experiment.primitiveId}`,
      preconditions: [...new Set(graph.nodes.map((node) => node.kind))],
      stableReplays: existing?.recipe.causalSupport.stableReplays ?? 0,
      experiments: evidence,
      existingRecipeId: existing?.recipe.id,
    };
    const draft = existing?.recipe ?? this.deps.promotion.compileDraft(input);
    if (!draft) return;
    const evaluated = this.deps.promotion.evaluate(input);
    const recipe = evaluated.pass ? evaluated.recipe : draft;
    await this.deps.recipeStore.save({
      recipe,
      lifecycle: evaluated.pass ? 'RECIPE_SAFE' : existing?.lifecycle ?? 'DRAFT',
      updatedWallMs: Date.now(),
      actions: input.actions,
      evidence,
      primitiveSequence: [...(existing?.primitiveSequence ?? []), {
        primitiveId: pending.experiment.primitiveId,
        opaqueRefs: [...pending.experiment.opaqueRefs],
      }],
    });
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
      const isBaitAction = action.type === 'DOM_PRESERVE_BAIT_CANDIDATE'
        || action.type === 'BAIT_PRESERVE_LAYOUT'
        || action.type === 'BAIT_RESTORE_VISIBILITY'
        || action.type === 'BAIT_DISABLE_COSMETIC_HIDE'
        || action.type === 'BAIT_PRESERVE_CHILD_STRUCTURE';
      if (!action.type.startsWith('DOM_') && !isBaitAction) return null;
      if (action.type === 'DOM_REMOVE_OVERLAY' || action.type === 'DOM_HIDE' || action.type === 'DOM_COLLAPSE') {
        if (!overlay) return null;
        out.push({ ...action, id: `${action.id}_replay_${Date.now()}`, targetRef: overlay });
      } else if (isBaitAction) {
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
