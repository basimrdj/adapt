import { calculateHealthVector } from '../../core/health/scorer';
import { NavigationRegistry } from '../../core/navigation/registry';
import { normalizeUrlForTelemetry } from '../../core/network/normalize-url';
import { RequestGraphManager } from '../../core/network/request-graph';
import {
  CausalDocumentKey,
  createEventId,
  EventNode,
  hashOrigin,
  HealthVectorCompact,
  OpaqueRef,
} from '../../shared/causal/events';
import { ExperimentSelectionBudget } from '../../shared/causal/experiments';
import { CausalPageObservationBatch, HealthVector, StrategyAction } from '../../shared/types';
import { createPageFingerprint, fingerprintEvidenceHash, PageFingerprint } from '../../shared/causal/recipes';
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
}

export class CausalOrchestrator {
  private readonly normalizer: EventNormalizer;
  private readonly candidates = new CandidateGenerator();
  private readonly experiments = new ExperimentGenerator();
  private readonly selector = new ExperimentSelector();
  private readonly previousHealth = new Map<string, HealthVector>();
  private readonly pendingReplays = new Map<string, PendingReplay>();
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

  async onPageObservation(tabId: number, frameId: number, batch: CausalPageObservationBatch): Promise<void> {
    const epoch = this.deps.registry.getEpoch(tabId, frameId);
    const scope = this.deps.registry.getCausalKey(tabId, frameId);
    // The content script cannot know the background navigationId. Identity was
    // already authenticated from MessageSender.documentId before this call.
    if (!epoch || !scope) return;
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
    if (!replaying) await this.maybeRun(graph, epoch.siteKey, epoch.navigationId, health);
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
    if (graph) await this.maybeDraftOrPromote(graph, state.hypothesisId, state.candidate.actions);
    const batch = this.lastBatches.get(`${tabId}:${frameId}:${state.documentId}`);
    if (batch) await this.deps.runFallback(tabId, state.navigationId, state.siteKey, batch);
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

  private async maybeRun(graph: ReturnType<EventGraphStore['getOrCreate']>, siteKey: string, navigationId: string, baselineHealth: HealthVector): Promise<void> {
    const key = this.deps.registry.getCausalKey(graph.scope.tabId, graph.nodes[0]?.scope.frameId ?? 0);
    if (!key) return;
    const candidates = this.experiments.generate(graph);
    const budget: ExperimentSelectionBudget = {
      ...graph.budgets,
      remaining: Math.max(0, graph.budgets.maxPerDocumentEpoch - graph.experiments.length),
    };
    const selected = this.selector.select(candidates, key, budget);
    if (!selected) return;
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
    });
    if (staged.record.status === 'STAGED' && staged.state) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, selected.expected.durationMs)));
      await this.deps.sendTabMessage(graph.scope.tabId, {
        v: 1,
        type: 'REQUEST_HEALTH_SNAPSHOT',
        txId: staged.state.txId,
      });
    }
  }

  private fingerprint(graph: ReturnType<EventGraphStore['getOrCreate']>, batch: CausalPageObservationBatch, url: string): PageFingerprint {
    const path = (() => { try { return new URL(url).pathname.split('/').filter(Boolean)[0] ?? 'root'; } catch { return 'unknown'; } })();
    const resources = graph.nodes
      .filter((node) => node.kind.startsWith('REQUEST_'))
      .map((node) => String(node.features.hostname ?? ''))
      .filter(Boolean)
      .sort();
    return createPageFingerprint({
      originHash: graph.scope.originHash,
      topLevelPathClass: path,
      detectorFeatureHash: hashOrigin([...batch.pageSignals.suspectedDetectorTypes].sort().join('|')),
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
    const fp = this.fingerprint(graph, batch, url);
    const actions = this.remapActions(record.actions, batch);
    if (!actions) return false;
    const txId = `causal_replay_${record.recipe.id}_${Date.now()}`;
    const applied: StrategyAction[] = [];
    try {
      for (const action of actions) {
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
    for (const action of [...pending.applied].reverse()) {
      try {
        await this.deps.sendTabMessage(pending.tabId, {
          v: 1, type: 'ROLLBACK_DOM_ACTION', txId: pending.txId,
          documentId: pending.documentId, actionId: action.id,
        });
      } catch { rollbackOk = false; }
    }
    const replayed = this.deps.promotion.replay(stored.recipe, pending.fingerprint, verification.scoreDelta, verification.success);
    const seq = (stored.evidence?.length ?? 0) + 1;
    const evidence = [...(stored.evidence ?? []), {
      id: `experiment:x${seq}` as const,
      candidateHash: hashOrigin(pending.txId), startedWallMs: Date.now() - 200,
      completedWallMs: Date.now(), status: verification.success ? 'COMMITTED' as const : 'ROLLED_BACK' as const,
      preHealth: this.toCompact(pending.baseline), postHealth: this.toCompact(post),
      healthDelta: verification.scoreDelta, observedRefs: [...stored.recipe.actionRefs],
      policyDecisionId: `policy:${stored.recipe.id}`, transactionId: pending.txId,
      rollbackVerified: rollbackOk, epochStillFresh: this.deps.registry.getCausalKey(pending.tabId, pending.frameId)?.documentId === pending.documentId,
      visitId: pending.documentId, fingerprintHash: fingerprintEvidenceHash(pending.fingerprint), replay: true,
      privacyScore: post.privacyPreservation ?? 0.5,
    }];
    const lifecycle = replayed.lifecycle === 'INVALIDATED'
      ? 'INVALIDATED'
      : replayed.recipe.causalSupport.stableReplays >= 1 ? 'CONFIRMED' : stored.lifecycle;
    await this.deps.recipeStore.save({ ...stored, recipe: replayed.recipe, lifecycle, evidence, updatedWallMs: Date.now() });
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

  private async maybeDraftOrPromote(graph: ReturnType<EventGraphStore['getOrCreate']>, hypothesisId: `hypothesis:h${number}`, actions: StrategyAction[]): Promise<void> {
    const hypothesis = graph.hypotheses.find((item) => item.id === hypothesisId);
    if (!hypothesis || hypothesis.status !== 'SUPPORTED') return;
    const existing = (await this.deps.recipeStore.getByOriginHash(graph.scope.originHash))
      .find((item) => item.recipe.causalSupport.hypothesisClass === hypothesis.mechanismClass);
    const lastHealth = graph.nodes.filter((node) => node.kind === 'HEALTH_SNAPSHOT').at(-1);
    const fingerprint = this.lastFingerprints.get(graph.graphId);
    if (!fingerprint) return;
    const experiments = this.deps.engine.getRecords()
      .filter((state) => state.hypothesisId === hypothesisId && state.record.status === 'COMMITTED')
      .map((state) => state.record);
    const input: PromotionEvaluateInput = {
      hypothesis, fingerprint, actionRefs: [...hypothesis.causeRefs], actions,
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
