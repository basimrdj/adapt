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
import { addEdge } from '../../shared/causal/graph';
import { ExperimentSelectionBudget } from '../../shared/causal/experiments';
import { CausalPageObservationBatch, HealthVector, NavigationEpoch, NavigationTargetObservation, OpaqueSurvivorObservation, StrategyAction, UserIntentEnvelope } from '../../shared/types';
import {
  checkFingerprint,
  CausalRecipeLifecycle,
  createPageFingerprint,
  fingerprintEvidenceHash,
  isIdentityMismatch,
  PageFingerprint,
  PrimitiveRecipeStep,
  RECIPE_SAFE_MIN_STABLE_REPLAYS,
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
import { AutonomousExperiment, AutonomousExperimentLoop, requiredEvidenceForPrimitive } from '../autonomy/saei';
import { AutonomyPendingState, AutonomySessionRepository, AutonomySessionSnapshot } from '../autonomy/session';
import { PrimitiveExecutorRegistry, primitiveRecipeActions } from '../autonomy/executor-registry';
import { PrimitiveId } from '../autonomy/primitive-registry';
import { isThirdPartyResource, registrableDomain, resourceIdentity } from '../../shared/resource-identity';
import { AdaptivePlanner } from '../../shared/ai/planner-interface';
import { EvidencePacket, OpaqueCandidateElement, OpaqueCandidateRequest } from '../../shared/ai/types';
import { PolicyValidator } from '../../shared/ai/validator';

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

function scopeKey(scope: CausalDocumentKey): string {
  return `${scope.tabId}:${scope.navigationEpoch}:${scope.documentId}:${scope.frameId}`;
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
      urlFilter: `|${target.protocol}//${target.host}${normalized.coarsePath}*`,
        resourceTypes: [type],
      firstParty: !isThirdPartyResource(raw.url, page.origin),
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

interface SurvivorAiTraceRecord {
  survivorRef?: string;
  survivorClass?: string;
  triggerReason: 'NOVEL_NETWORK_DISCOVERY' | 'SURVIVOR_ATTRIBUTION';
  candidateRefs: string[];
  candidateFeatureSummaries: Array<Record<string, string | number | boolean | null>>;
  aiInvoked: boolean;
  privacyMode: 'STRICT' | 'DOMAIN_HINTS';
  aiCandidateRanking?: string[];
  selectedExperiment?: { actionType: string; targetRef?: string };
  policyValidator?: { valid: boolean; reasons: string[] };
  executorResult?: string;
  postHealth?: HealthVector;
  survivorResolved?: boolean;
  sessionProtectionInstalled: boolean;
  persistentPromotionState: string;
  rollback: boolean;
  timing: { startedAt: number; latencyMs?: number };
}

interface PendingSurvivorAi {
  txId: string;
  traceIndex: number;
  baseline: HealthVector;
  tabId: number;
  frameId: number;
  documentId: string;
  primitiveId: PrimitiveId;
}

const PROMOTABLE_MECHANISMS: ReadonlySet<CausalHypothesis['mechanismClass']> = new Set([
  'BLOCKED_RESOURCE_PROBE',
  'BAIT_VISIBILITY_PROBE',
  'OVERLAY_REINSERTION',
  'SCROLL_LOCK_REACTION',
  'SERVICE_WORKER_CACHE_PATH',
  'SCRIPT_ORDER_DEPENDENCY',
  'COSMETIC_REMOVAL_DEPENDENCY',
  'UNKNOWN_DOM_REACTION',
  'UNKNOWN_NAVIGATION_REACTION',
  'UNKNOWN',
]);

function primitiveRecipeStep(
  primitiveId: AutonomousExperiment['primitiveId'],
  graph: ReturnType<EventGraphStore['getOrCreate']>,
  fingerprint: PageFingerprint
): PrimitiveRecipeStep {
  const navigationPrimitive = primitiveId.includes('NAVIGATION')
    || primitiveId === 'STOP_MATCHED_REDIRECT_CHAIN'
    || primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET';
  const remapping = primitiveId.includes('NETWORK') || primitiveId === 'TARGETED_SESSION_DNR'
    ? 'CURRENT_REQUEST_REF' as const
    : navigationPrimitive
      ? 'CURRENT_NAVIGATION_REF' as const
      : primitiveId === 'RESTORE_SCROLL' || primitiveId === 'RESTORE_POINTER_INTERACTION' || primitiveId === 'PLAYER_HEALTH_RECOVERY'
        ? 'NONE' as const
        : 'CURRENT_ELEMENT_REF' as const;
  const rollbackClass = primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
    ? 'CLOSED_TAB_REOPEN' as const
    : primitiveId.includes('NETWORK') || primitiveId === 'TARGETED_SESSION_DNR' || primitiveId === 'STOP_MATCHED_REDIRECT_CHAIN'
      ? 'SESSION_RULE' as const
      : 'DOM_ACTION' as const;
  return {
    primitiveId,
    requiredEvidenceClasses: requiredEvidenceForPrimitive(primitiveId),
    structuralPreconditions: [...new Set(graph.nodes.map((node) => node.kind))],
    behavioralPreconditions: primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
      ? ['INTENT_OUTCOME_FANOUT', 'DESTINATION_MISMATCH']
      : [primitiveId],
    opaqueRefRemappingRule: remapping,
    rollbackClass,
    fingerprintConstraints: {
      originHash: fingerprint.originHash,
      detectorFeatureHash: fingerprint.detectorFeatureHash,
      structuralFeatureHash: fingerprint.structuralFeatureHash,
      ...(navigationPrimitive ? {} : { topLevelPathClass: fingerprint.topLevelPathClass }),
    },
  };
}

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
  private readonly lastElements = new Map<string, CausalPageObservationBatch['elements']>();
  private readonly lastSurvivors = new Map<string, OpaqueSurvivorObservation[]>();
  private readonly lastObservationBatches = new Map<string, CausalPageObservationBatch>();
  private readonly autonomyLoops = new Map<string, AutonomousExperimentLoop>();
  private readonly pendingAutonomy = new Map<string, PendingAutonomy>();
  private readonly finalizingAutonomy = new Set<string>();
  private readonly pendingNavigationEvidence = new Map<number, { ref: OpaqueRef; kind: EventNode['kind']; features: EventNode['features'] }>();
  private readonly handledNavigationRefs = new Set<string>();
  private readonly outcomeVerifiers = new PrimitiveOutcomeVerifierRegistry();
  private readonly policyValidator = new PolicyValidator();
  private readonly survivorAiCalls = new Map<string, number>();
  private readonly auditedOrigins = new Set<string>();
  private readonly pendingSurvivorAi = new Map<string, PendingSurvivorAi>();
  private readonly survivorAiTrace: SurvivorAiTraceRecord[] = [];
  private adaptivePlanner?: AdaptivePlanner;
  private aiPrivacyMode: 'STRICT' | 'DOMAIN_HINTS' = 'STRICT';

  constructor(private readonly deps: CausalOrchestratorDeps) {
    this.normalizer = new EventNormalizer(deps.registry);
  }

  setAdaptivePlanner(planner: AdaptivePlanner | undefined): void {
    this.adaptivePlanner = planner;
  }

  setAiPrivacyMode(mode: 'STRICT' | 'DOMAIN_HINTS'): void {
    this.aiPrivacyMode = mode;
  }

  getSurvivorAiTrace(): readonly SurvivorAiTraceRecord[] {
    return this.survivorAiTrace.map((item) => ({
      ...item,
      candidateRefs: [...item.candidateRefs],
      candidateFeatureSummaries: item.candidateFeatureSummaries.map((summary) => ({ ...summary })),
    }));
  }

  hasPendingNavigationClosure(tabId: number): boolean {
    return [...this.pendingAutonomy.values()].some((pending) =>
      pending.tabId === tabId
      && pending.experiment.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
    );
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
    const graph = this.navigationSourceGraph(target, scope);
    if (!graph) return;
    const targetNode = graph.nodes.find((node) => node.refs.includes(target.ref));
    if (targetNode) {
      targetNode.features.classificationDisposition = classification.disposition;
      targetNode.features.classificationConfidence = classification.confidence;
    }
    const baseline = this.previousHealth.get(`${target.sourceTabId}:${target.sourceFrameId}:${scope.navigationEpoch}:${scope.documentId}`)
      ?? this.defaultHealth();
    if (classification.disposition === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET') {
      const replayed = await this.maybeReplayPrimitiveNavigation(target, graph, baseline);
      if (replayed) return;
    }
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
    if (raw.frameId === 0) {
      const carriedAutonomy = [...this.pendingAutonomy.values()].find((pending) =>
        pending.tabId === raw.tabId
        && pending.frameId === raw.frameId
        && pending.documentId !== raw.documentId
        && pending.experiment.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
      );
      if (carriedAutonomy) {
        await this.deps.sendTabMessage(raw.tabId, {
          v: 1,
          type: 'REQUEST_HEALTH_SNAPSHOT',
          txId: carriedAutonomy.txId,
          documentId: raw.documentId,
        }).catch(() => undefined);
      }
    }
    await this.deps.session.persist();
  }

  async onRequest(raw: RawRequestEvent, resources: CausalResourceRegistry, epochOverride?: NavigationEpoch): Promise<void> {
    const epoch = epochOverride ?? this.deps.registry.getEpoch(raw.tabId, raw.frameId);
    if (!epoch) return;
    resources.observe(raw, epoch.origin);
    const enrichedRaw: RawRequestEvent = {
      ...raw,
      resourceIdentityHash: raw.resourceIdentityHash ?? resourceIdentity(raw.url, epoch.origin)?.hash,
      thirdParty: raw.thirdParty ?? isThirdPartyResource(raw.url, epoch.origin),
    };
    const node = this.normalizer.normalizeRequest(enrichedRaw, epoch);
    if (!node) return;
    const key: CausalDocumentKey = {
      tabId: epoch.tabId,
      navigationEpoch: epoch.navigationEpoch,
      documentId: epoch.documentId,
      frameId: epoch.frameId,
    };
    const graph = this.deps.graphs.getOrCreate(key, node.scope.originHash);
    this.deps.graphs.append(node);
    if (raw.type === 'error') {
      this.deps.graphs.append(nowNode(key, graph.scope.originHash, 'NETWORK_PROBE_REACTION', node.refs, {
        resourceType: raw.resourceType ?? null,
        errorClass: raw.error ? 'REQUEST_ERROR' : 'UNKNOWN',
      }, 'webRequest', raw.timeStamp ?? Date.now()));
    }
    this.candidates.update(graph);
    graph.hypotheses = generateHypothesisLattice(graph.nodes, graph.hypotheses);
    if (raw.type === 'complete') {
      const latestObservation = this.lastObservationBatches.get(scopeKey(key));
      if (latestObservation) {
        await this.maybeRunSurvivorAi(
          raw.tabId,
          raw.frameId,
          epoch,
          key,
          graph,
          latestObservation,
          this.enrichHealth(calculateHealthVector(latestObservation.pageSignals), epoch.navigationId)
        );
      }
    }
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
    const graph = this.navigationSourceGraph(target, scope)
      ?? this.deps.graphs.getOrCreate(scope, hashOrigin(epoch.origin));
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
    const hasSameTabOutcome = target.recentIntentRef !== undefined
      && graph.nodes.some((node) => node.kind === 'NAV_COMMIT' && node.timestamp.value >= target.capturedWallMs - 2500);
    if (target.extraTarget && hasSameTabOutcome) {
      this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'INTENT_OUTCOME_FANOUT', [target.ref], {
        destinationClass: target.destinationClass,
        destinationMatch: target.destinationMatch ?? null,
      }, 'navigationIntent', target.capturedWallMs));
      graph.hypotheses = generateHypothesisLattice(graph.nodes, graph.hypotheses);
    }
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

  async onPageObservation(tabId: number, frameId: number, batch: CausalPageObservationBatch, epochOverride?: NavigationEpoch): Promise<boolean> {
    const epoch = epochOverride ?? this.deps.registry.getEpoch(tabId, frameId);
    const scope = epochOverride
      ? {
          tabId: epochOverride.tabId,
          navigationEpoch: epochOverride.navigationEpoch,
          documentId: epochOverride.documentId,
          frameId: epochOverride.frameId,
        }
      : this.deps.registry.getCausalKey(tabId, frameId);
    // The content script cannot know the background navigationId. Identity was
    // already authenticated from MessageSender.documentId before this call.
    if (!epoch || !scope) return false;
    const graph = this.deps.graphs.getOrCreate(scope, hashOrigin(epoch.origin));
    const documentScopeKey = scopeKey(scope);
    this.lastBatches.set(documentScopeKey, batch.pageSignals);
    this.lastElements.set(documentScopeKey, batch.elements);
    this.lastSurvivors.set(documentScopeKey, [...(batch.survivors ?? [])]);
    this.lastObservationBatches.set(documentScopeKey, {
      ...batch,
      elements: [...batch.elements],
      survivors: [...(batch.survivors ?? [])],
      resourceAssociations: [...(batch.resourceAssociations ?? [])],
      intents: [...(batch.intents ?? [])],
    });
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
      if ((element.role === 'fullscreen-overlay' || element.role === 'semantic-reaction-ui') && element.visible) {
        this.deps.graphs.append(nowNode(scope, graph.scope.originHash, 'OVERLAY_APPEARED', [element.ref], {
          coverage: element.viewportCoverage,
          benignModal: false,
          semanticReaction: element.role === 'semantic-reaction-ui',
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
    this.appendSurvivorEvidence(graph, scope, batch);
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
    graph.hypotheses = generateHypothesisLattice(graph.nodes, graph.hypotheses);
    const hasDeterministicCausalExperiment = this.experiments.generate(graph).length > 0;
    // Preserve the established deterministic path whenever it already has a
    // valid intervention. SAEI expands the lattice only for unresolved cases.
    await this.deps.session.persist();
    const replaying = await this.maybeReplay(graph, batch, health, epoch.url, scope);
    if (replaying) return true;
    if (!hasDeterministicCausalExperiment) {
      await this.maybeRunSurvivorAi(tabId, frameId, epoch, scope, graph, batch, health);
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
    const survivorAi = this.pendingSurvivorAi.get(txId);
    if (survivorAi) {
      await this.finishSurvivorAi(survivorAi, this.enrichHealth(health, this.deps.registry.getEpoch(tabId, frameId)?.navigationId ?? ''));
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
    const batch = this.lastBatches.get(scopeKey({
      tabId,
      navigationEpoch: state.navigationEpoch,
      documentId: state.documentId,
      frameId,
    }));
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

  private async maybeRunSurvivorAi(
    tabId: number,
    frameId: number,
    epoch: NonNullable<ReturnType<NavigationRegistry['getEpoch']>>,
    scope: CausalDocumentKey,
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    batch: CausalPageObservationBatch,
    health: HealthVector
  ): Promise<void> {
    if (!this.adaptivePlanner) return;
    const calls = this.survivorAiCalls.get(graph.graphId) ?? 0;
    if (calls >= 2) return;

    const survivors = (batch.survivors ?? []).filter((item) => !item.protectedContext.authOrPayment
      && !item.protectedContext.media
      && !item.protectedContext.downloadOrDocument);
    const candidateNodes = this.survivorRequestNodes(scope, survivors[0]);
    const originHash = hashOrigin(epoch.origin);
    const novelNetworkAudit = survivors.length === 0
      && candidateNodes.length >= 2
      && !this.auditedOrigins.has(originHash);
    const ambiguousSurvivor = survivors.length > 0 && candidateNodes.length > 0;
    if (!novelNetworkAudit && !ambiguousSurvivor) return;
    if (novelNetworkAudit) this.auditedOrigins.add(originHash);

    const startedAt = Date.now();
    const candidateRequests = this.toAiRequestCandidates(candidateNodes, survivors[0]);
    const candidateElements = this.toAiElementCandidates(survivors);
    if (candidateRequests.length === 0 && candidateElements.length === 0) return;
    const evidence = this.buildSurvivorEvidence(
      epoch,
      batch,
      health,
      candidateElements,
      candidateRequests,
      novelNetworkAudit ? 'NOVEL_NETWORK_DISCOVERY' : 'SURVIVOR_ATTRIBUTION'
    );
    const trace: SurvivorAiTraceRecord = {
      survivorRef: survivors[0]?.ref,
      survivorClass: survivors[0]?.class,
      triggerReason: novelNetworkAudit ? 'NOVEL_NETWORK_DISCOVERY' : 'SURVIVOR_ATTRIBUTION',
      candidateRefs: [...candidateRequests.map((item) => item.ref), ...candidateElements.map((item) => item.ref)],
      candidateFeatureSummaries: candidateRequests.map((item) => ({
        ref: item.ref,
        resourceType: item.resourceType,
        thirdParty: item.thirdParty ?? false,
        lagToSurvivorMs: item.lagToSurvivorMs ?? null,
        frameAssociation: item.frameAssociation ?? 'unknown',
        mutationAssociation: item.mutationAssociation ?? 0,
        repeatCount: item.repeatCount ?? 1,
      })),
      aiInvoked: true,
      privacyMode: this.aiPrivacyMode,
      sessionProtectionInstalled: false,
      persistentPromotionState: 'NOT_PROMOTED_MODEL_OPINION',
      rollback: false,
      timing: { startedAt },
    };
    const traceIndex = this.survivorAiTrace.push(trace) - 1;
    void this.persistSurvivorAiTrace();
    this.survivorAiCalls.set(graph.graphId, calls + 1);

    let rawPlan: unknown;
    try {
      rawPlan = await this.adaptivePlanner.plan(evidence);
      trace.timing.latencyMs = Date.now() - startedAt;
    } catch (error) {
      trace.timing.latencyMs = Date.now() - startedAt;
      trace.executorResult = `planner-failed:${error instanceof Error ? error.message : 'transport'}`;
      return;
    }

    const validation = this.policyValidator.validate(evidence, rawPlan);
    trace.policyValidator = { valid: validation.valid, reasons: [...validation.reasons] };
    if (!validation.valid || !validation.sanitizedPlan || validation.sanitizedPlan.decision !== 'ADAPT') return;
    const actions = validation.sanitizedPlan.actions;
    trace.aiCandidateRanking = actions.map((action) => action.targetRef).filter((ref): ref is string => Boolean(ref));
    const selected = actions.find((action) => action.actionType === 'TARGETED_SESSION_DNR' && action.targetRef?.startsWith('request:'))
      ?? actions.find((action) => (action.actionType === 'DOM_REMOVE_OVERLAY' || action.actionType === 'DOM_HIDE_CANDIDATE')
        && (action.targetRef?.startsWith('element:') || survivors[0]?.elementRef));
    if (!selected) return;
    trace.selectedExperiment = { actionType: selected.actionType, ...(selected.targetRef ? { targetRef: selected.targetRef } : {}) };

    const executors = this.deps.primitiveExecutors;
    if (!executors) {
      trace.executorResult = 'executor-unavailable';
      return;
    }
    const primitiveId: PrimitiveId = selected.actionType === 'TARGETED_SESSION_DNR'
      ? 'TARGETED_SESSION_DNR'
      : 'REMOVE_REACTION_UI';
    const targetRef = selected.targetRef
      ?? survivors[0]?.elementRef;
    if (!targetRef) return;
    const txId = `survivor_ai_${tabId}_${scope.navigationEpoch}_${Date.now()}`;
    const staged = await executors.stage({
      txId,
      tabId,
      frameId,
      documentId: scope.documentId,
      primitiveId,
      opaqueRefs: [targetRef],
      evidence: ['VISIBLE_AD_CANDIDATE', 'REQUEST_COMPLETE'],
    }).catch((error: unknown) => ({
      ok: false as const,
      gap: { code: 'EXECUTOR_ERROR' as const, reason: error instanceof Error ? error.message : String(error) },
    }));
    if (!staged.ok) {
      trace.executorResult = `rejected:${staged.gap.code}`;
      return;
    }
    trace.executorResult = 'staged';
    trace.sessionProtectionInstalled = primitiveId === 'TARGETED_SESSION_DNR';
    this.pendingSurvivorAi.set(txId, {
      txId,
      traceIndex,
      baseline: health,
      tabId,
      frameId,
      documentId: scope.documentId,
      primitiveId,
    });

    if (primitiveId === 'TARGETED_SESSION_DNR' && survivors[0]?.elementRef && !survivors[0].protectedContext.userIntentRelated) {
      await executors.stage({
        txId: `${txId}_repair`,
        tabId,
        frameId,
        documentId: scope.documentId,
        primitiveId: 'REMOVE_REACTION_UI',
        opaqueRefs: [survivors[0].elementRef],
        evidence: ['VISIBLE_AD_CANDIDATE'],
      }).catch(() => undefined);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await this.deps.sendTabMessage(tabId, {
      v: 1,
      type: 'REQUEST_HEALTH_SNAPSHOT',
      txId,
      documentId: scope.documentId,
    }).catch(() => undefined);
  }

  private async finishSurvivorAi(pending: PendingSurvivorAi, postHealth: HealthVector): Promise<void> {
    const trace = this.survivorAiTrace[pending.traceIndex];
    if (!trace) return;
    trace.postHealth = postHealth;
    const safe = compactScore(postHealth) >= compactScore(pending.baseline) - 0.05
      && postHealth.contentAvailability >= pending.baseline.contentAvailability - 0.05
      && postHealth.interaction >= 0.7;
    trace.survivorResolved = safe && (
      postHealth.visualObstruction <= pending.baseline.visualObstruction - 0.05
      || postHealth.antiBlockReaction <= pending.baseline.antiBlockReaction - 0.05
      || pending.primitiveId === 'TARGETED_SESSION_DNR'
    );
    if (!safe) {
      await this.deps.primitiveExecutors?.rollback(pending.txId).catch(() => undefined);
      trace.rollback = true;
      trace.sessionProtectionInstalled = false;
      trace.executorResult = 'rolled-back-health-regression';
    } else if (pending.primitiveId === 'TARGETED_SESSION_DNR') {
      trace.sessionProtectionInstalled = true;
    }
    this.pendingSurvivorAi.delete(pending.txId);
    await this.persistSurvivorAiTrace();
  }

  private async persistSurvivorAiTrace(): Promise<void> {
    try {
      await chrome.storage.session.set({ adapt_survivor_ai_trace: this.survivorAiTrace });
    } catch {
      // Trace persistence is diagnostic and must not affect page protection.
    }
  }

  private survivorRequestNodes(
    scope: CausalDocumentKey,
    survivor?: OpaqueSurvivorObservation
  ): EventNode[] {
    return this.deps.graphs.getAll()
      .filter((candidateGraph) => candidateGraph.scope.tabId === scope.tabId
        && candidateGraph.scope.navigationEpoch === scope.navigationEpoch
        && candidateGraph.scope.documentId === scope.documentId)
      .flatMap((candidateGraph) => candidateGraph.nodes)
      .filter((node) => node.kind === 'REQUEST_COMPLETE'
        && node.features.thirdParty === true
        && node.refs.some((ref) => ref.startsWith('request:'))
        && ['script', 'sub_frame', 'xmlhttprequest', 'fetch', 'beacon', 'image'].includes(String(node.features.resourceType ?? '')))
      .sort((a, b) => {
        const aMatch = survivor?.resourceIdentityHash && a.features.resourceIdentityHash === survivor.resourceIdentityHash ? 1 : 0;
        const bMatch = survivor?.resourceIdentityHash && b.features.resourceIdentityHash === survivor.resourceIdentityHash ? 1 : 0;
        return bMatch - aMatch || b.timestamp.value - a.timestamp.value;
      })
      .slice(0, 8);
  }

  private toAiRequestCandidates(nodes: readonly EventNode[], survivor?: OpaqueSurvivorObservation): OpaqueCandidateRequest[] {
    const seen = new Set<string>();
    return nodes.flatMap((node) => {
      const ref = node.refs.find((item): item is `request:r${number}` => item.startsWith('request:'));
      if (!ref || seen.has(ref)) return [];
      seen.add(ref);
      const hostname = String(node.features.hostname ?? 'unknown');
      const lag = survivor ? Math.max(0, survivor.observedAt - node.timestamp.value) : undefined;
      return [{
        ref,
        urlDomain: this.aiPrivacyMode === 'DOMAIN_HINTS' ? registrableDomain(hostname) : 'redacted',
        resourceType: String(node.features.resourceType ?? 'unknown'),
        isBlockedByBaseline: node.features.blocked === true || Boolean(node.features.error),
        failureObserved: Boolean(node.features.error),
        thirdParty: true,
        resourceIdentityHash: typeof node.features.resourceIdentityHash === 'string' ? node.features.resourceIdentityHash : undefined,
        lagToSurvivorMs: lag,
        frameAssociation: survivor && node.scope.frameId === 0 ? 'same-document' : 'related-frame',
        mutationAssociation: survivor?.resourceIdentityHash && node.features.resourceIdentityHash === survivor.resourceIdentityHash ? 1 : 0.35,
        repeatCount: typeof node.features.repeatCount === 'number' ? node.features.repeatCount : 1,
        filterEvidence: 'NONE',
      }];
    });
  }

  private toAiElementCandidates(survivors: readonly OpaqueSurvivorObservation[]): OpaqueCandidateElement[] {
    return survivors.filter((survivor) => survivor.elementRef).slice(0, 4).map((survivor) => ({
      ref: survivor.elementRef!,
      role: survivor.class,
      viewportCoverage: survivor.features.viewportCoverage,
      isFixedOrAbsolute: survivor.features.fixedOrAbsolute,
      hasHighZIndex: survivor.features.isolatedSurface,
      textSignals: survivor.evidenceClasses.slice(0, 5),
      interactionSuppressed: survivor.class === 'ANTI_BLOCK_REACTION',
    }));
  }

  private buildSurvivorEvidence(
    epoch: NonNullable<ReturnType<NavigationRegistry['getEpoch']>>,
    batch: CausalPageObservationBatch,
    health: HealthVector,
    candidateElements: OpaqueCandidateElement[],
    candidateRequests: OpaqueCandidateRequest[],
    reason: string
  ): EvidencePacket {
    return {
      schemaVersion: 1,
      transactionId: `survivor_evidence_${Date.now()}`,
      navigationEpoch: epoch.navigationId,
      timestamp: Date.now(),
      siteContext: { originClass: 'publisher', pageTypeEstimate: 'unknown' },
      trigger: { reason, confidence: Math.max(...(batch.survivors ?? []).map((item) => item.confidence), 0.55) },
      healthBefore: health,
      currentHealth: health,
      observedReaction: {
        detectorTypes: batch.pageSignals.suspectedDetectorTypes.slice(0, 6),
        antiBlockConfidence: health.antiBlockReaction,
        mutationBurstDetected: batch.pageSignals.mutation.rapidReinsertionDetected,
      },
      candidateElements,
      candidateRequests,
      availableActions: [
        ...(candidateRequests.length > 0 ? ['TARGETED_SESSION_DNR' as const] : []),
        ...(candidateElements.length > 0 ? ['DOM_REMOVE_OVERLAY' as const, 'DOM_HIDE_CANDIDATE' as const] : []),
        'ABSTAIN',
      ],
      knownConstraints: ['NO_ARBITRARY_CODE', 'OPAQUE_REFS_ONLY', 'NO_MAIN_FRAME_BLOCK', 'PROTECTED_CONTEXTS_ABSTAIN'],
      previousAttempts: [],
    };
  }

  private appendSurvivorEvidence(
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    scope: CausalDocumentKey,
    batch: CausalPageObservationBatch
  ): void {
    for (const survivor of batch.survivors ?? []) {
      const kind = this.survivorEventKind(survivor);
      const refs: OpaqueRef[] = [survivor.ref];
      if (survivor.elementRef) refs.push(survivor.elementRef);
      const node = nowNode(scope, graph.scope.originHash, kind, refs, {
        survivorClass: survivor.class,
        confidence: survivor.confidence,
        resourceIdentityHash: survivor.resourceIdentityHash ?? null,
        resourceType: survivor.resourceType ?? null,
        thirdPartyResource: survivor.features.thirdPartyResource,
        fixedOrAbsolute: survivor.features.fixedOrAbsolute,
        isolatedSurface: survivor.features.isolatedSurface,
        semanticAdLabel: survivor.features.semanticAdLabel,
        recentInsertion: survivor.features.recentInsertion,
        mutationAssociation: survivor.features.mutationAssociation,
        viewportCoverage: survivor.features.viewportCoverage,
        protectedAuthOrPayment: survivor.protectedContext.authOrPayment,
        protectedMedia: survivor.protectedContext.media,
        protectedDownloadOrDocument: survivor.protectedContext.downloadOrDocument,
      }, 'mutationObserver', survivor.observedAt);
      this.deps.graphs.append(node);

      const requestNodes = this.deps.graphs.getAll()
        .filter((candidateGraph) => candidateGraph.scope.tabId === scope.tabId
          && candidateGraph.scope.navigationEpoch === scope.navigationEpoch
          && candidateGraph.scope.documentId === scope.documentId)
        .flatMap((candidateGraph) => candidateGraph.nodes)
        .filter((candidate) => candidate.kind === 'REQUEST_COMPLETE' && candidate.refs.some((ref) => ref.startsWith('request:')))
        .slice(-96);

      for (const request of requestNodes) {
        const requestRef = request.refs.find((ref): ref is `request:r${number}` => ref.startsWith('request:'));
        if (!requestRef) continue;
        const lag = survivor.observedAt - request.timestamp.value;
        if (lag < 0 || lag > 5000) continue;
        const identityMatch = Boolean(
          survivor.resourceIdentityHash
          && request.features.resourceIdentityHash === survivor.resourceIdentityHash
        );
        const frameAssociation = request.scope.frameId === scope.frameId ? 'same-frame' : 'related-document';
        const plausible = identityMatch
          || (survivor.features.thirdPartyResource && request.features.thirdParty === true)
          || (frameAssociation === 'same-frame' && lag <= 1500);
        if (!plausible) continue;
        addEdge(graph, {
          id: `edge:${requestRef}:${survivor.ref}`,
          from: requestRef,
          to: survivor.ref,
          relation: 'POSSIBLY_CAUSES',
          lagMs: { min: Math.max(0, lag - 150), max: lag + 150 },
          status: identityMatch ? 'ASSOCIATED' : 'TEMPORAL_CANDIDATE',
          support: { observationalN: 1, interventionN: 0, positiveN: 0, negativeN: 0 },
          confounders: [],
          lastUpdatedWallMs: Date.now(),
        });
      }
    }
  }

  private survivorEventKind(survivor: OpaqueSurvivorObservation): EventNode['kind'] {
    switch (survivor.class) {
      case 'ANTI_BLOCK_REACTION': return 'ANTI_BLOCK_REACTION';
      case 'UNWANTED_NAVIGATION': return 'UNEXPECTED_NAV_TARGET';
      case 'POPUP_ATTEMPT': return 'POPUP_OR_POPUNDER';
      case 'SUSPICIOUS_REDIRECT': return 'SUSPICIOUS_REDIRECT_CHAIN';
      case 'PLAYER_OBSTRUCTION': return 'PLAYBACK_OBSTRUCTED';
      case 'REINSERTED_SURFACE': return 'REPEATED_REINSERTION';
      default: return 'VISIBLE_AD_CANDIDATE';
    }
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
    const eventKinds = new Set(graph.nodes.map((node) => node.kind));
    const reactionEvidenceReady = eventKinds.has('ANTI_BLOCK_REACTION') || eventKinds.has('SEMANTIC_GATE');
    const selected = eventKinds.has('PLAYBACK_OBSTRUCTED')
      ? undefined
      : eventKinds.has('OVERLAY_APPEARED') && !reactionEvidenceReady
      ? undefined
      : this.selector.select(candidates, key, budget);
    const autonomousSelection = forceAutonomous || !selected
      ? this.autonomousSelection(graph, baselineHealth)
      : null;
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
      const snapshot = loop.snapshot();
      loop.restore(observation, {
        ...snapshot,
        hypotheses: generateHypothesisLattice(observation.events, snapshot.hypotheses),
      });
    }
    const eventKinds = new Set(graph.nodes.map((node) => node.kind));
    const hasReactionOverlay = eventKinds.has('OVERLAY_APPEARED')
      && (eventKinds.has('ANTI_BLOCK_REACTION') || eventKinds.has('SEMANTIC_GATE'));
    const navigationTargetReaction = eventKinds.has('UNEXPECTED_NAV_TARGET') || eventKinds.has('POPUP_OR_POPUNDER');
    const redirectReaction = eventKinds.has('SUSPICIOUS_REDIRECT_CHAIN') || eventKinds.has('NAVIGATION_BOUNCE');
    const preferredPrimitive: PrimitiveId | undefined = hasReactionOverlay
      ? 'REMOVE_REACTION_UI'
      : navigationTargetReaction
        ? 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
        : redirectReaction
          ? 'STOP_MATCHED_REDIRECT_CHAIN'
          : eventKinds.has('PLAYBACK_OBSTRUCTED')
            ? 'PLAYER_HEALTH_RECOVERY'
            : eventKinds.has('SCROLL_LOCK_ON')
              ? 'RESTORE_SCROLL'
              : eventKinds.has('INTERACTION_DENIED')
                ? 'RESTORE_POINTER_INTERACTION'
                : graph.nodes
                  .slice()
                  .reverse()
                  .map((node) => node.features.classificationDisposition)
                  .find((value): value is PrimitiveId => typeof value === 'string');
    const experiment = loop.nextExperiment(preferredPrimitive);
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
    await this.requestAutonomyHealth(pending);
    return true;
  }

  private async requestAutonomyHealth(pending: PendingAutonomy): Promise<void> {
    const liveEpoch = this.deps.registry.getEpoch(pending.tabId, pending.frameId);
    const documentId = pending.experiment.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
      && liveEpoch
      && liveEpoch.documentId !== pending.documentId
      ? liveEpoch.documentId
      : pending.documentId;
    await this.deps.sendTabMessage(pending.tabId, {
      v: 1,
      type: 'REQUEST_HEALTH_SNAPSHOT',
      txId: pending.txId,
      documentId,
    }).catch(() => undefined);
  }

  private async finishAutonomous(
    pending: PendingAutonomy,
    postHealth: HealthVector
  ): Promise<void> {
    if (this.finalizingAutonomy.has(pending.txId) || !this.pendingAutonomy.has(pending.txId)) return;
    this.finalizingAutonomy.add(pending.txId);
    try {
      await this.finishAutonomousInternal(pending, postHealth);
    } finally {
      this.finalizingAutonomy.delete(pending.txId);
    }
  }

  private async finishAutonomousInternal(
    pending: PendingAutonomy,
    postHealth: HealthVector
  ): Promise<void> {
    const executors = this.deps.primitiveExecutors;
    const targetClosed = pending.experiment.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
      ? await executors?.ensureNavigationTargetClosed(pending.txId) ?? false
      : undefined;
    const pendingScope = this.deps.registry.getCausalKey(pending.tabId, pending.frameId);
    const postElements = pendingScope && pendingScope.documentId === pending.documentId
      ? this.lastElements.get(scopeKey(pendingScope))
      : undefined;
    const verification = this.outcomeVerifiers.verify(
      pending.experiment.primitiveId,
      pending.baseline,
      postHealth,
      {
        targetClosed: targetClosed ?? pending.execution.closedTargetUrl !== undefined,
        targetExists: targetClosed === false ? true : pending.execution.closedTargetUrl !== undefined ? false : undefined,
        redirectStopped: pending.execution.navigationRef !== undefined,
        baitPreserved: postElements?.some((element) => element.role === 'bait-candidate' && element.visible),
        layoutRestored: postElements?.some((element) => element.role === 'bait-candidate'),
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
    await this.deps.engine.recordAutonomousExperiment({
      record,
      tabId: pending.tabId,
      navigationEpoch: this.deps.registry.getEpoch(pending.tabId, pending.frameId)?.navigationEpoch ?? 0,
      documentId: pending.documentId,
      frameId: pending.frameId,
      siteKey: pending.siteKey,
      navigationId: pending.navigationId,
      txId: pending.txId,
      baselineHealth: pending.baseline,
      hypothesisId: pending.experiment.hypothesisId,
      baselineFingerprint: pending.fingerprint,
    });
    const graph = this.deps.graphs.getAll().find((item) => item.graphId === pending.graphId)
      ?? this.deps.graphs.get({
        tabId: pending.tabId,
        navigationEpoch: this.deps.registry.getEpoch(pending.tabId, pending.frameId)?.navigationEpoch ?? 0,
        documentId: pending.documentId,
        frameId: pending.frameId,
      });
    const loop = this.autonomyLoops.get(pending.graphId);
    if (graph) {
      if (!graph.experiments.some((item) => item.id === record.id)) {
        graph.experiments.push(record);
      }
      this.deps.beliefs.apply(graph, record, pending.experiment.hypothesisId);
      const hypothesis = graph.hypotheses.find((item) => item.id === pending.experiment.hypothesisId);
      if (hypothesis && verification.success) {
        if (pending.recipeReplay) {
          await this.finishPrimitiveRecipeReplay(pending, record);
        } else {
          await this.promoteAutonomous(graph, hypothesis, pending, record);
        }
      }
    }
    await this.deps.session.persist();
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

  private async maybeReplayPrimitiveNavigation(
    target: NavigationTargetObservation,
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    baseline: HealthVector
  ): Promise<boolean> {
    const fingerprint = this.lastFingerprints.get(graph.graphId);
    if (!fingerprint || !this.deps.primitiveExecutors) return false;
    const records = await this.deps.recipeStore.getByOriginHash(graph.scope.originHash);
    const record = records.find((item) => {
      if (item.lifecycle === 'INVALIDATED' || !item.primitiveSequence?.some((step) => step.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET')) return false;
      return checkFingerprint({
        originHash: item.recipe.originHash,
        ...item.recipe.fingerprintConstraints,
        relevantResourceSetHash: undefined,
      }, fingerprint).ok;
    });
    const step = record?.primitiveSequence?.find((item) => item.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET');
    if (!record || !step || step.opaqueRefRemappingRule !== 'CURRENT_NAVIGATION_REF') return false;
    const hypothesis = graph.hypotheses.find((item) => item.mechanismClass === 'UNKNOWN_NAVIGATION_REACTION');
    if (!hypothesis) return false;
    const primitiveId = step.primitiveId as AutonomousExperiment['primitiveId'];
    const experiment: AutonomousExperiment = {
      id: `experiment:x${Date.now()}` as `experiment:x${number}`,
      hypothesisId: hypothesis.id,
      primitiveId,
      expectedInformationGain: 1,
      expectedRisk: 0,
      expectedPrivacyRisk: 0,
      durationMs: 500,
      opaqueRefs: [target.ref],
    };
    const txId = `recipe_replay_${record.recipe.id}_${Date.now()}`;
    const staged = await this.deps.primitiveExecutors.stage({
      txId,
      tabId: target.sourceTabId,
      frameId: target.sourceFrameId,
      documentId: graph.scope.documentId,
      primitiveId,
      opaqueRefs: [target.ref],
      evidence: step.requiredEvidenceClasses,
    }).catch(() => ({ ok: false as const, gap: { code: 'EXECUTOR_ERROR' as const, reason: 'recipe replay executor failed' } }));
    if (!staged.ok) return false;
    this.pendingAutonomy.set(txId, {
      txId,
      graphId: graph.graphId,
      experiment,
      execution: staged.record,
      baseline,
      fingerprint,
      siteKey: this.deps.registry.getEpoch(target.sourceTabId, target.sourceFrameId)?.siteKey ?? '',
      navigationId: this.deps.registry.getEpoch(target.sourceTabId, target.sourceFrameId)?.navigationId ?? '',
      frameId: target.sourceFrameId,
      documentId: graph.scope.documentId,
      tabId: target.sourceTabId,
      recipeReplay: {
        recordId: record.recipe.id,
        applicationKey: `${record.recipe.id}:${graph.scope.documentId}`,
        fingerprint,
      },
    });
    await this.persistAutonomySession();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await this.deps.sendTabMessage(target.sourceTabId, {
      v: 1,
      type: 'REQUEST_HEALTH_SNAPSHOT',
      txId,
      documentId: graph.scope.documentId,
    }).catch(() => undefined);
    return true;
  }

  private navigationSourceGraph(
    target: NavigationTargetObservation,
    currentScope: CausalDocumentKey
  ): ReturnType<EventGraphStore['getOrCreate']> | undefined {
    const referencedGraph = this.deps.graphs.getAll().find((candidate) =>
      candidate.nodes.some((node) =>
        node.refs.includes(target.ref)
        || (target.recentIntentRef !== undefined && node.refs.includes(target.recentIntentRef))
      )
    );
    if (referencedGraph) return referencedGraph;
    if (!target.sourceDocumentId || target.sourceDocumentId === currentScope.documentId) {
      return this.deps.graphs.get(currentScope);
    }
    return this.deps.graphs.getAll().find((candidate) =>
      candidate.scope.tabId === target.sourceTabId
      && candidate.nodes[0]?.scope.frameId === target.sourceFrameId
      && candidate.scope.documentId === target.sourceDocumentId
    );
  }

  private primitiveReplayRefs(
    primitiveId: PrimitiveId,
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    batch: CausalPageObservationBatch,
  ): string[] | null {
    const requiredEvidence = requiredEvidenceForPrimitive(primitiveId);
    const eventKinds = new Set<string>(graph.nodes.map((node) => node.kind));
    if (primitiveId === 'REMOVE_REACTION_UI') {
      const overlayObserved = batch.pageSignals.geometry.hasFixedOverlay
        || batch.elements.some((element) => element.role === 'fullscreen-overlay' || element.role === 'semantic-reaction-ui');
      if (!overlayObserved) return null;
    } else if (requiredEvidence.some((kind) => !eventKinds.has(kind))) {
      return null;
    }

    if (primitiveId === 'RESTORE_SCROLL' || primitiveId === 'RESTORE_POINTER_INTERACTION' || primitiveId === 'PLAYER_HEALTH_RECOVERY') {
      return [];
    }
    if (primitiveId.includes('NETWORK') || primitiveId === 'TARGETED_SESSION_DNR') {
      const ref = [...graph.nodes].reverse().flatMap((node) => node.refs).find((value) => value.startsWith('request:'));
      return ref ? [ref] : null;
    }
    if (primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET' || primitiveId === 'STOP_MATCHED_REDIRECT_CHAIN') {
      return null;
    }
    const wantsBait = primitiveId === 'PRESERVE_BAIT' || primitiveId === 'RESTORE_LAYOUT';
    const element = batch.elements.find((item) => item.visible && (wantsBait ? item.role === 'bait-candidate' : item.role === 'fullscreen-overlay' || item.role === 'semantic-reaction-ui'))
      ?? batch.elements.find((item) => wantsBait ? item.role === 'bait-candidate' : item.role === 'fullscreen-overlay' || item.role === 'semantic-reaction-ui')
      ?? [...graph.nodes].reverse().find((node) => node.kind === 'OVERLAY_APPEARED')?.refs
        .find((ref): ref is `element:e${number}` => ref.startsWith('element:'));
    const elementRef = typeof element === 'string' ? element : element?.ref;
    return elementRef ? [elementRef] : null;
  }

  private async maybeReplayPrimitivePage(
    record: NonNullable<Awaited<ReturnType<CausalRecipeStore['getByOriginHash']>>[number]>,
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    batch: CausalPageObservationBatch,
    baseline: HealthVector,
    fingerprint: PageFingerprint,
    scope: CausalDocumentKey,
  ): Promise<boolean> {
    const step = record.primitiveSequence?.find((item) => item.primitiveId !== 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET' && item.primitiveId !== 'STOP_MATCHED_REDIRECT_CHAIN');
    if (!step || step.opaqueRefRemappingRule === 'CURRENT_NAVIGATION_REF') return false;
    const applicationKey = `${record.recipe.id}:${scope.documentId}`;
    if (this.completedRecipeApplications.has(applicationKey)) return true;
    if ([...this.pendingAutonomy.values()].some((pending) => pending.recipeReplay?.applicationKey === applicationKey)) return true;
    const primitiveId = step.primitiveId as PrimitiveId;
    const refs = this.primitiveReplayRefs(primitiveId, graph, batch);
    if (refs === null) return true;
    const txId = `recipe_replay_${record.recipe.id}_${Date.now()}`;
    const experiment: AutonomousExperiment = {
      id: `experiment:x${Date.now()}` as `experiment:x${number}`,
      hypothesisId: 'hypothesis:h1',
      primitiveId,
      expectedInformationGain: 1,
      expectedRisk: 0,
      expectedPrivacyRisk: 0,
      durationMs: 500,
      opaqueRefs: refs,
    };
    const staged = await this.deps.primitiveExecutors?.stage({
      txId,
      tabId: scope.tabId,
      frameId: scope.frameId,
      documentId: scope.documentId,
      primitiveId,
      opaqueRefs: refs,
      evidence: step.requiredEvidenceClasses,
    }).catch(() => undefined);
    if (!staged?.ok) return false;
    const hypothesis = graph.hypotheses.find((item) => item.mechanismClass === record.recipe.causalSupport.hypothesisClass)
      ?? graph.hypotheses[0];
    if (!hypothesis) {
      await this.deps.primitiveExecutors?.rollback(txId);
      return false;
    }
    this.pendingAutonomy.set(txId, {
      txId,
      graphId: graph.graphId,
      experiment: { ...experiment, hypothesisId: hypothesis.id },
      execution: staged.record,
      baseline,
      fingerprint,
      siteKey: this.deps.registry.getEpoch(scope.tabId, scope.frameId)?.siteKey ?? '',
      navigationId: this.deps.registry.getEpoch(scope.tabId, scope.frameId)?.navigationId ?? '',
      frameId: scope.frameId,
      documentId: scope.documentId,
      tabId: scope.tabId,
      recipeReplay: {
        recordId: record.recipe.id,
        applicationKey: `${record.recipe.id}:${scope.documentId}`,
        fingerprint,
      },
    });
    await this.persistAutonomySession();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await this.deps.sendTabMessage(scope.tabId, {
      v: 1,
      type: 'REQUEST_HEALTH_SNAPSHOT',
      txId,
      documentId: scope.documentId,
    }).catch(() => undefined);
    return true;
  }

  private async finishPrimitiveRecipeReplay(
    pending: PendingAutonomy,
    record: ExperimentRecord
  ): Promise<void> {
    const replay = pending.recipeReplay;
    if (!replay) return;
    const stored = await this.deps.recipeStore.getRecipe(replay.recordId as `recipe:rcp${number}`);
    if (!stored) return;
    const replayed = this.deps.promotion.replay(
      stored.recipe,
      replay.fingerprint,
      record.healthDelta ?? 0,
      record.status === 'COMMITTED' && record.rollbackVerified !== false
    );
    const evidence = [...(stored.evidence ?? []), { ...record, replay: true }];
    let lifecycle: CausalRecipeLifecycle = replayed.lifecycle === 'INVALIDATED'
      ? 'INVALIDATED'
      : replayed.recipe.causalSupport.stableReplays >= 2 ? 'RECIPE_SAFE' : 'CONFIRMED';
    let recipe = replayed.recipe;
    if (lifecycle !== 'INVALIDATED' && replayed.recipe.causalSupport.stableReplays >= 2) {
      const hypothesis: CausalHypothesis = {
        id: 'hypothesis:h0',
        causeRefs: [],
        outcome: 'UNWANTED_NAVIGATION',
        mechanismClass: stored.recipe.causalSupport.hypothesisClass as CausalHypothesis['mechanismClass'],
        prior: stored.recipe.causalSupport.posterior,
        posterior: stored.recipe.causalSupport.posterior,
        confoundingRisk: 'LOW',
        status: 'SUPPORTED',
        createdFrom: [],
        updatedByExperiments: evidence.map((item) => item.id),
      };
      const promoted = this.deps.promotion.evaluate({
        hypothesis,
        fingerprint: replay.fingerprint,
        fingerprintConstraints: stored.recipe.fingerprintConstraints,
        actionRefs: [...stored.recipe.actionRefs],
        actions: stored.actions ?? [],
        primitiveSequence: stored.primitiveSequence,
        expectedHealthDelta: stored.recipe.expectedHealthDelta,
        minPrivacyScore: Math.min(...evidence.map((item) => item.privacyScore ?? 1), 1),
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
    await this.deps.recipeStore.save({
      ...stored,
      recipe,
      lifecycle,
      evidence,
      updatedWallMs: Date.now(),
      invalidationReason: lifecycle === 'INVALIDATED' ? 'REPLAY_HEALTH_OR_ROLLBACK' : undefined,
    });
    this.completedRecipeApplications.add(replay.applicationKey);
  }

  private async promoteAutonomous(
    graph: ReturnType<EventGraphStore['getOrCreate']>,
    hypothesis: CausalHypothesis,
    pending: PendingAutonomy,
    record: ExperimentRecord
  ): Promise<void> {
    const fingerprint = pending.fingerprint ?? this.lastFingerprints.get(graph.graphId);
    const actions = primitiveRecipeActions(pending.experiment.primitiveId, pending.experiment.opaqueRefs);
    if (!fingerprint) return;
    const existing = (await this.deps.recipeStore.getByOriginHash(fingerprint.originHash))
      .find((item) => item.recipe.causalSupport.hypothesisClass === hypothesis.mechanismClass);
    const evidence = [...(existing?.evidence ?? []), record];
    const step = primitiveRecipeStep(pending.experiment.primitiveId, graph, fingerprint);
    const navigationPrimitive = pending.experiment.primitiveId.includes('NAVIGATION')
      || pending.experiment.primitiveId === 'STOP_MATCHED_REDIRECT_CHAIN'
      || pending.experiment.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET';
    const networkPrimitive = pending.experiment.primitiveId.includes('NETWORK')
      || pending.experiment.primitiveId === 'TARGETED_SESSION_DNR';
    const primitiveSequence = existing?.primitiveSequence?.some((item) => item.primitiveId === step.primitiveId)
      ? [...existing.primitiveSequence]
      : [...(existing?.primitiveSequence ?? []), step];
    const replayActionRefs = actions.length > 0
      ? pending.experiment.opaqueRefs.filter((ref) => !ref.startsWith('navigation:')) as OpaqueRef[]
      : [];
    const input: PromotionEvaluateInput = {
      hypothesis,
      fingerprint,
      fingerprintConstraints: existing?.recipe.fingerprintConstraints ?? {
        originHash: fingerprint.originHash,
        detectorFeatureHash: fingerprint.detectorFeatureHash,
        structuralFeatureHash: fingerprint.structuralFeatureHash,
        ...(navigationPrimitive ? {} : {
          topLevelPathClass: fingerprint.topLevelPathClass,
          ...(networkPrimitive ? { relevantResourceSetHash: fingerprint.relevantResourceSetHash } : {}),
        }),
      },
      actionRefs: existing?.recipe.actionRefs ? [...existing.recipe.actionRefs] : replayActionRefs,
      actions: existing?.actions ? [...existing.actions] : actions,
      expectedHealthDelta: record.healthDelta ?? 0,
      minPrivacyScore: record.privacyScore ?? 1,
      rollbackPlanRef: `rollback:${pending.experiment.primitiveId}`,
      preconditions: [...new Set(graph.nodes.map((node) => node.kind))],
      stableReplays: existing?.recipe.causalSupport.stableReplays ?? 0,
      experiments: evidence,
      existingRecipeId: existing?.recipe.id,
      primitiveSequence,
    };
    const draft = existing?.recipe ?? this.deps.promotion.compileDraft(input);
    if (!draft) return;
    const evaluated = this.deps.promotion.evaluate(input);
    const recipe = evaluated.pass ? evaluated.recipe : draft;
    const applicationKey = `${recipe.id}:${graph.scope.documentId}`;
    this.completedRecipeApplications.add(applicationKey);
    try {
      await this.deps.recipeStore.save({
        recipe,
        lifecycle: evaluated.pass ? 'RECIPE_SAFE' : existing?.lifecycle ?? 'DRAFT',
        updatedWallMs: Date.now(),
        actions: input.actions,
        evidence,
        primitiveSequence,
      });
    } catch (error) {
      this.completedRecipeApplications.delete(applicationKey);
      throw error;
    }
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
    const detectorIdentityTypes: string[] = batch.pageSignals.suspectedDetectorTypes
      .filter((type) => type === 'FULLSCREEN_GATE')
      .sort();
    for (const category of batch.pageSignals.semantic.categories ?? []) {
      detectorIdentityTypes.push(`SEMANTIC_CATEGORY:${category}`);
    }
    detectorIdentityTypes.sort();
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
    const overlay = batch.elements.find((element) => (element.role === 'fullscreen-overlay' || element.role === 'semantic-reaction-ui') && element.visible)?.ref;
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
    primitiveId: string,
    batch: CausalPageObservationBatch
  ): boolean {
    const hasVisibleOverlay = batch.elements.some(
      (element) => (element.role === 'fullscreen-overlay' || element.role === 'semantic-reaction-ui') && element.visible
    );
    const hasBait = batch.elements.some((element) => element.role === 'bait-candidate');
    if (primitiveId === 'RESTORE_SCROLL') {
      return batch.pageSignals.geometry.bodyScrollLocked
        || batch.pageSignals.geometry.htmlScrollLocked;
    }
    if (primitiveId === 'RESTORE_POINTER_INTERACTION') {
      return batch.pageSignals.interaction.pointerEventsSuppressed || hasVisibleOverlay;
    }
    if (primitiveId === 'PLAYER_HEALTH_RECOVERY') {
      return batch.pageSignals.interaction.pointerEventsSuppressed
        || batch.pageSignals.semantic.categories?.includes('PLAYBACK_GATE') === true;
    }
    if (primitiveId === 'REMOVE_REACTION_UI' || primitiveId === 'RESTORE_LAYOUT') {
      return hasVisibleOverlay || batch.pageSignals.semantic.categories?.includes('ANTI_BLOCK_INSTRUCTION') === true;
    }
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
    const fp = this.fingerprint(graph, batch, url);
    const record = records.find((item) => {
      if (item.lifecycle === 'INVALIDATED' || (!item.primitiveSequence?.length && !item.actions?.length)) return false;
      const pathConstraint = item.recipe.fingerprintConstraints.topLevelPathClass;
      if (pathConstraint === undefined) return true;
      return checkFingerprint({
        originHash: item.recipe.originHash,
        topLevelPathClass: pathConstraint,
      }, fp).ok;
    });
    if (!record) return false;
    const primitiveStep = record.primitiveSequence?.[0];
    if (primitiveStep?.requiredEvidenceClasses.includes('OVERLAY_APPEARED')
      && !batch.pageSignals.geometry.hasFixedOverlay
      && !batch.elements.some((element) => element.role === 'fullscreen-overlay' && element.visible)) {
      return true;
    }
    if (!this.recipeBaselineObservable(record.recipe.causalSupport.hypothesisClass, primitiveStep?.primitiveId ?? '', batch)) {
      // The document is still assembling the causal baseline. Abstain until a
      // later observation instead of applying or invalidating on partial data.
      return true;
    }
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
    if (record.primitiveSequence?.length) {
      return this.maybeReplayPrimitivePage(record, graph, batch, baseline, fp, scope);
    }
    const applicationKey = `${record.recipe.id}:${scope.documentId}`;
    if (this.completedRecipeApplications.has(applicationKey)) return true;
    if (!record.actions) return false;
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
    const replayPrimitive = stored.primitiveSequence?.[0]?.primitiveId as PrimitiveId | undefined;
    const mechanismVerification = replayPrimitive === 'REMOVE_REACTION_UI'
      || replayPrimitive === 'TOGGLE_COSMETIC_ACTION'
      || replayPrimitive === 'RESTORE_SCROLL'
      || replayPrimitive === 'RESTORE_POINTER_INTERACTION'
      || replayPrimitive === 'PLAYER_HEALTH_RECOVERY'
      ? this.outcomeVerifiers.verify(replayPrimitive, pending.baseline, post)
      : undefined;
    const verification = mechanismVerification ?? verifyHealthOutcome(pending.baseline, post);
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
      rollbackVerified: pending.keepAppliedOnSuccess ? verification.success : rollbackOk,
      epochStillFresh: this.deps.registry.getCausalKey(pending.tabId, pending.frameId)?.documentId === pending.documentId,
      visitId: pending.documentId, fingerprintHash: fingerprintEvidenceHash(pending.fingerprint), replay: true,
      privacyScore: post.privacyPreservation ?? 0.5,
    }];
    let lifecycle: CausalRecipeLifecycle = replayed.lifecycle === 'INVALIDATED'
      ? 'INVALIDATED'
      : replayed.recipe.causalSupport.stableReplays >= RECIPE_SAFE_MIN_STABLE_REPLAYS
        ? 'RECIPE_SAFE'
        : replayed.recipe.causalSupport.stableReplays >= 1
          ? 'CONFIRMED'
          : stored.lifecycle;
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
          primitiveSequence: stored.primitiveSequence,
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
      this.completedRecipeApplications.add(`${promoted.recipe.id}:${graph.scope.documentId}`);
    } else if (!existing) {
      const draft = this.deps.promotion.compileDraft(input);
      if (draft) {
        await this.deps.recipeStore.save({ recipe: draft, lifecycle: 'DRAFT', actions, evidence: experiments, updatedWallMs: Date.now() });
        this.completedRecipeApplications.add(`${draft.id}:${graph.scope.documentId}`);
      }
    }
  }
}
