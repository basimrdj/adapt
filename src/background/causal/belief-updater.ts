/**
 * Phase 3 M5 — Bayesian / sequential belief updater (spec §10, §21.3–21.4, §36 M5).
 *
 * Maintains per-hypothesis BetaBelief (private map) and writes posterior mean
 * onto CausalHypothesis.posterior. May set SUPPORTED or REFUTED; never CONFIRMED
 * and never writes a SiteRecipe (INV-X10 / M6).
 */

import {
  BeliefDecision,
  BetaBelief,
  DEFAULT_SEQUENTIAL_BOUNDS,
  EffectEstimate,
  SequentialBounds,
  UNIFORM_PRIOR,
  WelfordAccumulator,
  boundsForMechanism,
  ciCovers,
  classifyTrial,
  effectFromWelford,
  emptyWelford,
  observedN,
  posteriorMean,
  pushWelford,
  successRateCi95,
  updateBeta,
} from '../../shared/causal/belief';
import {
  CausalHypothesis,
  EventGraph,
  ExperimentRecord,
} from '../../shared/causal/events';

export class BeliefUpdater {
  private readonly beliefs = new Map<string, BetaBelief>();
  private readonly welfords = new Map<string, WelfordAccumulator>();
  private readonly aliases = new Map<string, string>();
  private readonly prior: BetaBelief;
  private readonly bounds: SequentialBounds;

  constructor(options?: { prior?: BetaBelief; bounds?: Partial<SequentialBounds> }) {
    this.prior = options?.prior ?? UNIFORM_PRIOR;
    this.bounds = { ...DEFAULT_SEQUENTIAL_BOUNDS, ...options?.bounds };
  }

  public getBelief(hypothesisId: CausalHypothesis['id']): BetaBelief | undefined {
    const stored = this.beliefs.get(this.aliases.get(hypothesisId) ?? hypothesisId);
    return stored ? { ...stored } : undefined;
  }

  public getEffect(hypothesisId: CausalHypothesis['id']): EffectEstimate | undefined {
    const acc = this.welfords.get(this.aliases.get(hypothesisId) ?? hypothesisId);
    if (!acc) return undefined;
    return effectFromWelford(acc);
  }

  public snapshot(): {
    beliefs: Array<[string, BetaBelief]>;
    welfords: Array<[string, WelfordAccumulator]>;
  } {
    return {
      beliefs: Array.from(this.beliefs.entries()).map(([id, value]) => [id, { ...value }]),
      welfords: Array.from(this.welfords.entries()).map(([id, value]) => [id, { ...value }]),
    };
  }

  public hydrate(snapshot: {
    beliefs?: Array<[string, BetaBelief]>;
    welfords?: Array<[string, WelfordAccumulator]>;
  }): void {
    this.beliefs.clear();
    this.welfords.clear();
    for (const [id, value] of snapshot.beliefs ?? []) {
      if (id.length > 0 && value.alpha > 0 && value.beta > 0) {
        this.beliefs.set(id, { ...value });
      }
    }
    for (const [id, value] of snapshot.welfords ?? []) {
      if (id.length > 0 && value.n >= 0) this.welfords.set(id, { ...value });
    }
  }

  /**
   * Sequential stopping rule (spec §21.4).
   * SUPPORT requires posterior mean, n, and success-rate CI — never posterior mean alone.
   * CONFIRMED is not a decide() output (M6).
   */
  public decide(
    hypothesis: CausalHypothesis,
    belief: BetaBelief,
    effect: EffectEstimate,
    attempts: number
  ): BeliefDecision {
    const bounds = boundsForMechanism(hypothesis.mechanismClass);
    const maxAttempts = Math.max(bounds.maxAttempts, this.bounds.maxAttempts);
    const confounded = hypothesis.confoundingRisk === 'HIGH';
    return this.evaluate(hypothesis, belief, effect, attempts, maxAttempts, confounded);
  }

  public apply(
    graph: EventGraph,
    record: ExperimentRecord,
    hypothesisId: `hypothesis:h${number}`
  ): EventGraph {
    const hyp = graph.hypotheses.find((h) => h.id === hypothesisId);
    if (!hyp) return graph;

    const trial = classifyTrial(record, this.bounds.minMeaningfulHealthDelta);
    if (trial === 'ignore') return graph;

    if (hyp.updatedByExperiments.includes(record.id)) return graph;

    hyp.updatedByExperiments = [...hyp.updatedByExperiments, record.id];
    if (!graph.experiments.some((e) => e.id === record.id)) {
      graph.experiments = [...graph.experiments, record];
    }

    // Element/request IDs are intentionally document-local opaque refs. Using
    // them as the cross-visit key fragments one causal mechanism whenever an
    // overlay is re-created. Event kinds retain the structural causal signature
    // without persisting selectors, user content, or document-local IDs.
    const structuralKinds = hyp.createdFrom
      .filter((ref) => ref.startsWith('event:'))
      .map((ref) => graph.nodes.find((node) => node.id === ref)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => kind !== undefined)
      .filter((kind, index, kinds) => kinds.indexOf(kind) === index)
      .sort()
      .join('>');
    const causalSignature = structuralKinds || hyp.causeRefs
      .filter((ref) => !ref.startsWith('event:'))
      .sort()
      .join(',') || 'unknown-structure';
    const evidenceKey = `${graph.scope.originHash}|${hyp.mechanismClass}|${hyp.outcome}|${causalSignature}`;
    this.aliases.set(hypothesisId, evidenceKey);
    const prevBelief = this.beliefs.get(evidenceKey) ?? { ...this.prior };
    const nextBelief = updateBeta(prevBelief, trial === 'success' ? 1 : 0);
    this.beliefs.set(evidenceKey, nextBelief);

    const delta = record.healthDelta ?? 0;
    const prevW = this.welfords.get(evidenceKey) ?? emptyWelford();
    const nextW = pushWelford(prevW, delta);
    this.welfords.set(evidenceKey, nextW);

    const effect = effectFromWelford(nextW);
    const mean = posteriorMean(nextBelief);
    hyp.posterior = mean;

    const attempts = hyp.updatedByExperiments.length;
    const maxAttempts = graph.budgets.maxPerDocumentEpoch;
    const confounded = this.isConfounded(graph, hyp);
    if (confounded && hyp.confoundingRisk === 'LOW') {
      hyp.confoundingRisk = 'MEDIUM';
    }

    const decision = this.evaluate(
      hyp,
      nextBelief,
      effect,
      attempts,
      maxAttempts,
      confounded
    );

    if (decision === 'SUPPORT') {
      hyp.status = 'SUPPORTED';
    } else if (decision === 'REFUTE') {
      hyp.status = 'REFUTED';
    } else if (hyp.status !== 'SUPPORTED' && hyp.status !== 'REFUTED') {
      hyp.status = 'CANDIDATE';
    }
    // M5 never writes CONFIRMED — that is M6 recipe promotion.

    this.touchEdges(graph, hyp, trial === 'success', mean, effect, decision, confounded);
    return graph;
  }

  private evaluate(
    hypothesis: CausalHypothesis,
    belief: BetaBelief,
    effect: EffectEstimate,
    attempts: number,
    maxAttempts: number,
    confounded: boolean
  ): BeliefDecision {
    const bounds = { ...boundsForMechanism(hypothesis.mechanismClass), ...this.bounds };
    const mean = posteriorMean(belief);
    const n = observedN(belief, this.prior);
    const rateCi = successRateCi95(belief, this.prior);
    const effectCiFinite =
      Number.isFinite(effect.ci95[0]) && Number.isFinite(effect.ci95[1]);

    const crossesSupport =
      mean >= bounds.supportPosterior &&
      n >= bounds.supportMinN &&
      rateCi[0] > bounds.supportCiLower &&
      effectCiFinite &&
      effect.n >= bounds.supportMinN;

    const crossesFutility =
      mean <= bounds.futilityPosterior && n >= bounds.futilityMinN;

    if (crossesSupport && !confounded) {
      return 'SUPPORT';
    }
    if (crossesFutility) {
      return 'REFUTE';
    }
    if (attempts >= maxAttempts) {
      if (ciCovers(rateCi, 0.5) || confounded || !crossesSupport) {
        return 'STOP_UNCERTAIN';
      }
    }
    if (confounded && crossesSupport) {
      return 'STOP_UNCERTAIN';
    }
    return 'CONTINUE';
  }

  /**
   * Confounded = HIGH risk, or competing hyps sharing an outcome with no
   * discriminating (unique) intervention on this hypothesis yet.
   * Unique experiments on this hyp (even if a decoy sits untested) are enough
   * to leave the support path open — test 1 vs test 3.
   */
  private isConfounded(graph: EventGraph, hyp: CausalHypothesis): boolean {
    if (hyp.confoundingRisk === 'HIGH') return true;

    const competitors = graph.hypotheses.filter(
      (other) =>
        other.id !== hyp.id &&
        other.status !== 'REFUTED' &&
        other.outcome === hyp.outcome &&
        sharesEvidence(hyp, other)
    );
    if (competitors.length === 0) return false;

    const unique = hyp.updatedByExperiments.filter(
      (id) => !competitors.some((c) => c.updatedByExperiments.includes(id))
    );
    if (unique.length > 0) return false;

    const competitorAlsoSucceeded = competitors.some((c) => {
      const b = this.beliefs.get(this.aliases.get(c.id) ?? c.id);
      if (!b) return false;
      return posteriorMean(b) >= this.bounds.supportPosterior && observedN(b, this.prior) > 0;
    });
    if (competitorAlsoSucceeded) return true;

    return hyp.updatedByExperiments.length === 0;
  }

  private touchEdges(
    graph: EventGraph,
    hyp: CausalHypothesis,
    success: boolean,
    mean: number,
    effect: EffectEstimate,
    decision: BeliefDecision,
    confounded: boolean
  ): void {
    const refs = new Set<string>([...hyp.causeRefs, ...hyp.createdFrom]);
    for (const edge of graph.edges) {
      if (!refs.has(edge.from) && !refs.has(edge.to)) continue;
      edge.support.interventionN += 1;
      if (success) edge.support.positiveN += 1;
      else edge.support.negativeN += 1;
      edge.support.posteriorProbability = mean;
      edge.support.effectMean = effect.meanDelta;
      edge.support.effectCi95 = effect.ci95;
      edge.lastUpdatedWallMs = Date.now();
      if (confounded && decision !== 'REFUTE') {
        edge.status = 'CONFOUNDED_OR_AMBIGUOUS';
      } else if (decision === 'SUPPORT') {
        edge.status = 'INTERVENTION_SUPPORTED';
      } else if (decision === 'REFUTE') {
        edge.status = 'INTERVENTION_REFUTED';
      }
    }
  }
}

function sharesEvidence(a: CausalHypothesis, b: CausalHypothesis): boolean {
  const aRefs = new Set<string>([...a.causeRefs, ...a.createdFrom]);
  for (const ref of [...b.causeRefs, ...b.createdFrom]) {
    if (aRefs.has(ref)) return true;
  }
  return false;
}
