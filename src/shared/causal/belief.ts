/**
 * Phase 3 M5 — Bayesian / sequential belief types (spec §10, §21.3–21.4).
 *
 * Online layer is a small-hypothesis Beta-Bernoulli posterior plus a Welford
 * health-delta EffectEstimate. Recipe promotion (CONFIRMED / SiteRecipe) is M6.
 */

import { DEFAULT_EXPERIMENT_BUDGET } from './graph';
import { CausalHypothesis, ExperimentRecord } from './events';

export interface BetaBelief {
  alpha: number;
  beta: number;
}

export interface EffectEstimate {
  n: number;
  meanDelta: number;
  variance: number;
  ci95: [number, number];
}

export interface WelfordAccumulator {
  n: number;
  mean: number;
  m2: number;
}

export type BeliefDecision = 'CONTINUE' | 'SUPPORT' | 'REFUTE' | 'STOP_UNCERTAIN';

export interface SequentialBounds {
  maxAttempts: number;
  supportPosterior: number;
  supportMinN: number;
  supportCiLower: number;
  futilityPosterior: number;
  futilityMinN: number;
  minMeaningfulHealthDelta: number;
}

/** Uniform / Jeffreys-style unknown prior. Mean 0.5; n = alpha+beta-2. */
export const UNIFORM_PRIOR: BetaBelief = { alpha: 1, beta: 1 };

export const Z95 = 1.96;

export const WIDE_CI95: [number, number] = [
  Number.NEGATIVE_INFINITY,
  Number.POSITIVE_INFINITY,
];

export const DEFAULT_SEQUENTIAL_BOUNDS: SequentialBounds = {
  maxAttempts: DEFAULT_EXPERIMENT_BUDGET.maxPerDocumentEpoch,
  supportPosterior: 0.8,
  supportMinN: 5,
  supportCiLower: 0.5,
  futilityPosterior: 0.3,
  futilityMinN: 3,
  minMeaningfulHealthDelta: 0.05,
};

export function posteriorMean(belief: BetaBelief): number {
  const denom = belief.alpha + belief.beta;
  if (!(denom > 0) || !Number.isFinite(denom)) return 0.5;
  return belief.alpha / denom;
}

export function observedN(belief: BetaBelief, prior: BetaBelief = UNIFORM_PRIOR): number {
  const n = belief.alpha + belief.beta - prior.alpha - prior.beta;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function updateBeta(belief: BetaBelief, success: 0 | 1): BetaBelief {
  return {
    alpha: belief.alpha + success,
    beta: belief.beta + (1 - success),
  };
}

export function emptyWelford(): WelfordAccumulator {
  return { n: 0, mean: 0, m2: 0 };
}

export function pushWelford(state: WelfordAccumulator, x: number): WelfordAccumulator {
  const n = state.n + 1;
  const delta = x - state.mean;
  const mean = state.mean + delta / n;
  const delta2 = x - mean;
  return { n, mean, m2: state.m2 + delta * delta2 };
}

export function sampleVariance(state: WelfordAccumulator): number {
  if (state.n < 2) return 0;
  return state.m2 / (state.n - 1);
}

export function emptyEffectEstimate(): EffectEstimate {
  return {
    n: 0,
    meanDelta: 0,
    variance: 0,
    ci95: [WIDE_CI95[0], WIDE_CI95[1]],
  };
}

/**
 * Small-sample Student-t interval using the sample variance.
 * n < 2 → infinite dummy so a support boundary cannot fire.
 */
export function effectFromWelford(state: WelfordAccumulator): EffectEstimate {
  const variance = sampleVariance(state);
  if (state.n < 2) {
    return {
      n: state.n,
      meanDelta: state.mean,
      variance,
      ci95: [WIDE_CI95[0], WIDE_CI95[1]],
    };
  }
  const se = Math.sqrt(variance / state.n);
  const t95 = [Infinity, Infinity, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262][state.n] ?? 1.96;
  const half = t95 * se;
  return {
    n: state.n,
    meanDelta: state.mean,
    variance,
    ci95: [state.mean - half, state.mean + half],
  };
}

/**
 * Wilson 95% interval on the empirical success rate (0/1). Unlike the
 * small-sample normal interval, all-success n=2 or n=3 does not collapse to 1.
 * Used by the support/futility boundaries (lower > 0.5 / covers 0.5).
 */
export function successRateCi95(
  belief: BetaBelief,
  prior: BetaBelief = UNIFORM_PRIOR
): [number, number] {
  const n = observedN(belief, prior);
  if (n < 1) return [WIDE_CI95[0], WIDE_CI95[1]];
  const successes = Math.max(0, belief.alpha - prior.alpha);
  const p = successes / n;
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (Z95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export type BinaryTrial = 'success' | 'failure' | 'ignore';

/**
 * Binary outcome for the Beta update.
 * COMMITTED with healthDelta >= minMeaningful → success.
 * ROLLED_BACK / ABORTED / negative delta → failure.
 * STALE (and incomplete STAGED) → ignore.
 * COMMITTED below the meaningful-delta floor is not a success (counts as failure).
 */
export function classifyTrial(
  record: ExperimentRecord,
  minMeaningfulHealthDelta: number = DEFAULT_SEQUENTIAL_BOUNDS.minMeaningfulHealthDelta
): BinaryTrial {
  if (record.status === 'STALE' || record.status === 'STAGED') return 'ignore';
  const delta = record.healthDelta ?? 0;
  if (record.status === 'COMMITTED' && delta >= minMeaningfulHealthDelta) return 'success';
  if (record.status === 'ROLLED_BACK' || record.status === 'ABORTED') return 'failure';
  if (delta < 0) return 'failure';
  if (record.status === 'COMMITTED') return 'failure';
  return 'ignore';
}

export function boundsForMechanism(
  _mechanismClass: CausalHypothesis['mechanismClass']
): SequentialBounds {
  return { ...DEFAULT_SEQUENTIAL_BOUNDS };
}

export function ciCovers(ci: [number, number], value: number): boolean {
  return ci[0] <= value && value <= ci[1];
}
