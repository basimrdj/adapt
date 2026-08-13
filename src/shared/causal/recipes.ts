/**
 * Phase 3 M6 — CausalRecipe + PageFingerprint (spec §17, §22).
 *
 * Fingerprints use structural/technical features only — never user content,
 * form values, cookies, or full page text.
 * Recipe promotion / invalidation lives in PromotionGate (M6).
 * M5 may set SUPPORTED; only M6 may set CONFIRMED / RecipeSafe.
 */

import { ExperimentRecord, hashOrigin, OpaqueRef } from './events';
import { StrategyAction } from '../types';

/** Spec §17. */
export interface PageFingerprint {
  originHash: string;
  topLevelPathClass: string;
  detectorFeatureHash: string;
  relevantResourceSetHash: string;
  structuralFeatureHash: string;
  serviceWorkerVersionHint?: string;
  createdWallMs: number;
}

/** Spec §22. */
export interface CausalRecipe {
  id: `recipe:rcp${number}`;
  version: 1;
  originHash: string;
  fingerprintConstraints: Partial<PageFingerprint>;
  preconditions: string[];
  actionRefs: OpaqueRef[];
  causalSupport: {
    hypothesisClass: string;
    posterior: number;
    experiments: number;
    stableReplays: number;
  };
  expectedHealthDelta: number;
  minPrivacyScore: number;
  rollbackPlanRef: string;
}

/**
 * Operational lifecycle around a spec-exact CausalRecipe.
 * Candidate → Supported is M5. Confirmed / RecipeSafe / Invalidated are M6.
 */
export type CausalRecipeLifecycle = 'DRAFT' | 'CONFIRMED' | 'RECIPE_SAFE' | 'INVALIDATED';

export interface CausalRecipeRecord {
  recipe: CausalRecipe;
  lifecycle: CausalRecipeLifecycle;
  updatedWallMs: number;
  /** Frozen allowlisted actions plus direct evidence needed for operational replay/promotion. */
  actions?: StrategyAction[];
  evidence?: ExperimentRecord[];
}

export const CAUSAL_RECIPE_VERSION = 1 as const;

export const MIN_PRIVACY_SCORE_FOR_PROMOTION = 0.9;

/** RecipeSafe requires a second successful visit replay (stableReplays >= 2). */
export const RECIPE_SAFE_MIN_STABLE_REPLAYS = 2;

/** Confirmed (replication) requires at least one stable replay. */
export const CONFIRMED_MIN_STABLE_REPLAYS = 1;

/** Replay health must be at least this fraction of expectedHealthDelta. */
export const REPLAY_HEALTH_DELTA_RATIO = 0.5;

export const PROMOTION_GATES = [
  'safety',
  'statistical',
  'replay',
  'privacy',
  'fingerprint',
  'rollback',
] as const;

export type PromotionGateName = (typeof PROMOTION_GATES)[number];

export type FingerprintCheckKind =
  | 'MATCH'
  | 'MISSING_CONSTRAINT'
  | 'ORIGIN_MISMATCH'
  | 'DETECTOR_MISMATCH'
  | 'STRUCTURAL_MISMATCH'
  | 'RESOURCE_MISMATCH'
  | 'PATH_CLASS_MISMATCH';

export type FingerprintCheck =
  | { ok: true; kind: 'MATCH' }
  | { ok: false; kind: Exclude<FingerprintCheckKind, 'MATCH'> };

const IDENTITY_MISMATCH: ReadonlySet<FingerprintCheckKind> = new Set([
  'ORIGIN_MISMATCH',
  'DETECTOR_MISMATCH',
  'STRUCTURAL_MISMATCH',
]);

export function isIdentityMismatch(kind: FingerprintCheckKind): boolean {
  return IDENTITY_MISMATCH.has(kind);
}

export function recipeId(n: number): CausalRecipe['id'] {
  return `recipe:rcp${n}`;
}

export function isCausalRecipeId(value: string): value is CausalRecipe['id'] {
  return /^recipe:rcp\d+$/.test(value);
}

/**
 * Strip user-prose / whitespace tokens. Fingerprints must stay structural.
 */
export function hashTechnicalTokens(tokens: ReadonlyArray<string | number | boolean>): string {
  const safe: string[] = [];
  for (const t of tokens) {
    const s = String(t);
    if (s.length === 0 || s.length > 128) continue;
    if (/\s/.test(s)) continue;
    safe.push(s);
  }
  return hashOrigin(safe.join('\u0000'));
}

export function createPageFingerprint(parts: {
  originHash: string;
  topLevelPathClass: string;
  detectorFeatureHash: string;
  relevantResourceSetHash: string;
  structuralFeatureHash: string;
  serviceWorkerVersionHint?: string;
  createdWallMs?: number;
}): PageFingerprint {
  const fp: PageFingerprint = {
    originHash: parts.originHash,
    topLevelPathClass: parts.topLevelPathClass,
    detectorFeatureHash: parts.detectorFeatureHash,
    relevantResourceSetHash: parts.relevantResourceSetHash,
    structuralFeatureHash: parts.structuralFeatureHash,
    createdWallMs: parts.createdWallMs ?? 0,
  };
  if (parts.serviceWorkerVersionHint !== undefined) {
    fp.serviceWorkerVersionHint = parts.serviceWorkerVersionHint;
  }
  return fp;
}

export function fingerprintEvidenceHash(fp: PageFingerprint): string {
  return hashTechnicalTokens([
    fp.originHash,
    fp.topLevelPathClass,
    fp.detectorFeatureHash,
    fp.relevantResourceSetHash,
    fp.structuralFeatureHash,
    fp.serviceWorkerVersionHint ?? 'none',
  ]);
}

/**
 * Constraints stored on a recipe. createdWallMs is not a match key.
 */
export function defaultConstraints(fp: PageFingerprint): Partial<PageFingerprint> {
  const c: Partial<PageFingerprint> = {
    originHash: fp.originHash,
    topLevelPathClass: fp.topLevelPathClass,
    detectorFeatureHash: fp.detectorFeatureHash,
    relevantResourceSetHash: fp.relevantResourceSetHash,
    structuralFeatureHash: fp.structuralFeatureHash,
  };
  if (fp.serviceWorkerVersionHint !== undefined) {
    c.serviceWorkerVersionHint = fp.serviceWorkerVersionHint;
  }
  return c;
}

/**
 * Path class: exact, prefix (boundary at '/'), or single-segment class match.
 * Unrelated route classes are not equivalent.
 */
export function pathClassMatches(constraint: string, incoming: string): boolean {
  const norm = (s: string): string => s.replace(/^\/+|\/+$/g, '');
  const c = norm(constraint);
  const i = norm(incoming);
  if (c.length === 0) return false;
  if (c === i) return true;
  if (i.startsWith(c + '/')) return true;
  return false;
}

export function checkFingerprint(
  constraints: Partial<PageFingerprint>,
  incoming: PageFingerprint
): FingerprintCheck {
  if (constraints.originHash === undefined || constraints.originHash.length === 0) {
    return { ok: false, kind: 'MISSING_CONSTRAINT' };
  }
  if (incoming.originHash.length === 0 || incoming.originHash !== constraints.originHash) {
    return { ok: false, kind: 'ORIGIN_MISMATCH' };
  }

  if (constraints.detectorFeatureHash !== undefined) {
    if (constraints.detectorFeatureHash.length === 0) {
      return { ok: false, kind: 'MISSING_CONSTRAINT' };
    }
    if (incoming.detectorFeatureHash.length === 0) {
      return { ok: false, kind: 'MISSING_CONSTRAINT' };
    }
    if (incoming.detectorFeatureHash !== constraints.detectorFeatureHash) {
      return { ok: false, kind: 'DETECTOR_MISMATCH' };
    }
  }

  if (constraints.structuralFeatureHash !== undefined) {
    if (constraints.structuralFeatureHash.length === 0) {
      return { ok: false, kind: 'MISSING_CONSTRAINT' };
    }
    if (incoming.structuralFeatureHash.length === 0) {
      return { ok: false, kind: 'MISSING_CONSTRAINT' };
    }
    if (incoming.structuralFeatureHash !== constraints.structuralFeatureHash) {
      return { ok: false, kind: 'STRUCTURAL_MISMATCH' };
    }
  }

  if (constraints.relevantResourceSetHash !== undefined) {
    if (constraints.relevantResourceSetHash.length === 0) {
      return { ok: false, kind: 'MISSING_CONSTRAINT' };
    }
    if (incoming.relevantResourceSetHash.length === 0) {
      return { ok: false, kind: 'MISSING_CONSTRAINT' };
    }
    if (incoming.relevantResourceSetHash !== constraints.relevantResourceSetHash) {
      return { ok: false, kind: 'RESOURCE_MISMATCH' };
    }
  }

  if (constraints.topLevelPathClass !== undefined) {
    if (constraints.topLevelPathClass.length === 0) {
      return { ok: false, kind: 'MISSING_CONSTRAINT' };
    }
    if (incoming.topLevelPathClass.length === 0) {
      return { ok: false, kind: 'MISSING_CONSTRAINT' };
    }
    if (!pathClassMatches(constraints.topLevelPathClass, incoming.topLevelPathClass)) {
      return { ok: false, kind: 'PATH_CLASS_MISMATCH' };
    }
  }

  return { ok: true, kind: 'MATCH' };
}

export function replayHealthOk(healthDelta: number, expectedHealthDelta: number): boolean {
  return healthDelta >= expectedHealthDelta * REPLAY_HEALTH_DELTA_RATIO;
}

export function cloneRecipe(recipe: CausalRecipe): CausalRecipe {
  return {
    ...recipe,
    fingerprintConstraints: { ...recipe.fingerprintConstraints },
    preconditions: [...recipe.preconditions],
    actionRefs: [...recipe.actionRefs],
    causalSupport: { ...recipe.causalSupport },
  };
}
