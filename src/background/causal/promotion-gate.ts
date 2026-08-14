/**
 * Phase 3 M6 — PromotionGate (spec §22).
 *
 * A causal finding becomes a persistent deterministic recipe only if ALL pass:
 *   Safety AND statistical AND replay AND privacy AND fingerprint AND rollback
 *
 * M5 may set SUPPORTED. Only evaluate() pass may set CONFIRMED / RecipeSafe.
 * Never auto-promote from a single experiment (INV-X10).
 *
 * Compiling a draft CausalRecipe from SUPPORTED without replays is allowed;
 * evaluate / evaluatePromotion return FAIL until stableReplays >= 2.
 */

import { NOOP_SESSION_ALLOW_FILTER } from './experiment-to-strategy';
import { StorageBackend } from '../../core/recipes/store';
import { DEFAULT_SEQUENTIAL_BOUNDS, successRateCi95 } from '../../shared/causal/belief';
import { CausalHypothesis, ExperimentRecord } from '../../shared/causal/events';
import { containsForbiddenToken } from '../../shared/causal/experiments';
import {
  CAUSAL_RECIPE_VERSION,
  CausalRecipe,
  CausalRecipeLifecycle,
  CausalRecipeRecord,
  MIN_PRIVACY_SCORE_FOR_PROMOTION,
  PageFingerprint,
  PROMOTION_GATES,
  PromotionGateName,
  RECIPE_SAFE_MIN_STABLE_REPLAYS,
  checkFingerprint,
  cloneRecipe,
  defaultConstraints,
  isIdentityMismatch,
  recipeId,
  replayHealthOk,
  fingerprintEvidenceHash,
} from '../../shared/causal/recipes';
import { STORAGE_KEYS } from '../../shared/constants';
import { ActionType, StrategyAction, StrategyCandidate } from '../../shared/types';

const REVERSIBLE_ACTION_TYPES: ReadonlySet<ActionType> = new Set([
  'NET_BLOCK',
  'NET_ALLOW_EXCEPTION',
  'DOM_HIDE',
  'DOM_COLLAPSE',
  'DOM_RESTORE',
  'DOM_REMOVE_OVERLAY',
  'DOM_RESTORE_SCROLL',
  'DOM_RESTORE_POINTER_EVENTS',
  'DOM_PRESERVE_BAIT_CANDIDATE',
  'BAIT_PRESERVE_LAYOUT',
  'BAIT_RESTORE_VISIBILITY',
  'BAIT_DISABLE_COSMETIC_HIDE',
  'BAIT_PRESERVE_CHILD_STRUCTURE',
]);

const FORBIDDEN_CONTEXT_RE =
  /form[_\s-]?submit|purchase|subscribe|login|logout|paywall|password|credential|auth[_\s-]?bypass/i;

export interface PromotionEvaluateInput {
  hypothesis: CausalHypothesis;
  fingerprint: PageFingerprint;
  fingerprintConstraints?: Partial<PageFingerprint>;
  actionRefs: CausalRecipe['actionRefs'];
  actions: StrategyAction[];
  expectedHealthDelta: number;
  minPrivacyScore: number;
  rollbackPlanRef: string;
  preconditions?: string[];
  stableReplays: number;
  experiments: ReadonlyArray<ExperimentRecord>;
  mappedStrategy?: StrategyCandidate;
  existingRecipeId?: CausalRecipe['id'];
}

export type PromotionEvaluateResult =
  | { pass: true; recipe: CausalRecipe }
  | { pass: false; failedGates: PromotionGateName[] };

export interface PromotionReplayResult {
  recipe: CausalRecipe;
  lifecycle: CausalRecipeLifecycle;
  applied: boolean;
}

interface StoredBundle {
  items: Record<string, CausalRecipeRecord>;
  nextSeq: number;
}

function isNoopInvalidAllow(urlFilter: string): boolean {
  if (urlFilter === NOOP_SESSION_ALLOW_FILTER) return true;
  return urlFilter.includes('.invalid');
}

function isPersistentTrackerAllow(action: StrategyAction): boolean {
  if (action.type !== 'NET_ALLOW_EXCEPTION') return false;
  return !isNoopInvalidAllow(action.urlFilter);
}

function actionText(action: StrategyAction): string[] {
  const parts: string[] = [action.id, action.type];
  if (action.description !== undefined) parts.push(action.description);
  if ('selector' in action && typeof action.selector === 'string') parts.push(action.selector);
  if ('cssText' in action && typeof action.cssText === 'string') parts.push(action.cssText);
  if ('urlFilter' in action && typeof action.urlFilter === 'string') parts.push(action.urlFilter);
  if ('opId' in action && typeof action.opId === 'string') parts.push(action.opId);
  return parts;
}

function hasForbiddenContext(texts: ReadonlyArray<string>): boolean {
  for (const t of texts) {
    if (FORBIDDEN_CONTEXT_RE.test(t) || containsForbiddenToken(t)) return true;
  }
  return false;
}

function experimentCount(input: PromotionEvaluateInput): number {
  return verifiedExperiments(input).length;
}

function verifiedExperiments(input: PromotionEvaluateInput): ExperimentRecord[] {
  const seen = new Set<string>();
  return input.experiments.filter((record) => {
    if (record.status !== 'COMMITTED' || !record.epochStillFresh || !record.completedWallMs) return false;
    if (!record.transactionId || seen.has(record.transactionId)) return false;
    seen.add(record.transactionId);
    return true;
  });
}

function derivedStableReplays(input: PromotionEvaluateInput): number {
  const expected = fingerprintEvidenceHash(input.fingerprint);
  const visits = new Set<string>();
  for (const record of verifiedExperiments(input)) {
    if (record.replay !== true || record.fingerprintHash !== expected || !record.visitId) continue;
    visits.add(record.visitId);
  }
  return visits.size;
}

function derivedPrivacyScore(input: PromotionEvaluateInput): number {
  const scores = verifiedExperiments(input)
    .map((record) => record.privacyScore ?? record.postHealth?.privacyPreservation)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  return scores.length > 0 ? Math.min(...scores) : 0;
}

function lastExperiment(records: ReadonlyArray<ExperimentRecord>): ExperimentRecord | undefined {
  if (records.length === 0) return undefined;
  let best = records[0];
  if (best === undefined) return undefined;
  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    if (rec === undefined) continue;
    const recT = rec.completedWallMs ?? rec.startedWallMs;
    const bestT = best.completedWallMs ?? best.startedWallMs;
    if (recT >= bestT) best = rec;
  }
  return best;
}

export class CausalRecipeStore {
  private backend: StorageBackend;
  private memoryCache = new Map<string, CausalRecipeRecord>();
  private nextSeq = 1;
  private initialized = false;

  constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const data = await this.backend.get([STORAGE_KEYS.CAUSAL_RECIPES]);
      const stored = data[STORAGE_KEYS.CAUSAL_RECIPES] as StoredBundle | undefined;
      if (stored && typeof stored === 'object' && stored.items && typeof stored.items === 'object') {
        for (const [key, rec] of Object.entries(stored.items)) {
          this.memoryCache.set(key, rec);
        }
        if (typeof stored.nextSeq === 'number' && stored.nextSeq > this.nextSeq) {
          this.nextSeq = stored.nextSeq;
        }
      }
    } catch {
      // Memory fallback if storage is empty.
    }
    this.initialized = true;
  }

  public allocateId(): CausalRecipe['id'] {
    const id = recipeId(this.nextSeq);
    this.nextSeq += 1;
    return id;
  }

  public peekNextSeq(): number {
    return this.nextSeq;
  }

  public async getRecipe(id: CausalRecipe['id']): Promise<CausalRecipeRecord | undefined> {
    await this.init();
    return this.memoryCache.get(id);
  }

  public async getByOriginHash(originHash: string): Promise<CausalRecipeRecord[]> {
    await this.init();
    const out: CausalRecipeRecord[] = [];
    for (const rec of this.memoryCache.values()) {
      if (rec.recipe.originHash === originHash) out.push(rec);
    }
    return out;
  }

  public async save(record: CausalRecipeRecord): Promise<void> {
    await this.init();
    this.memoryCache.set(record.recipe.id, record);
    await this.persist();
  }

  public async delete(id: CausalRecipe['id']): Promise<void> {
    await this.init();
    this.memoryCache.delete(id);
    await this.persist();
  }

  public async getAll(): Promise<CausalRecipeRecord[]> {
    await this.init();
    return Array.from(this.memoryCache.values());
  }

  private async persist(): Promise<void> {
    const items: Record<string, CausalRecipeRecord> = {};
    for (const [k, v] of this.memoryCache.entries()) {
      items[k] = v;
    }
    const bundle: StoredBundle = { items, nextSeq: this.nextSeq };
    await this.backend.set({ [STORAGE_KEYS.CAUSAL_RECIPES]: bundle });
  }
}

export class PromotionGate {
  private seq = 1;
  private readonly lifecycleById = new Map<string, CausalRecipeLifecycle>();
  private readonly store: CausalRecipeStore | undefined;

  constructor(options?: { store?: CausalRecipeStore; startSeq?: number }) {
    this.store = options?.store;
    if (options?.startSeq !== undefined) this.seq = options.startSeq;
  }

  public getLifecycle(id: CausalRecipe['id']): CausalRecipeLifecycle | undefined {
    return this.lifecycleById.get(id);
  }

  /**
   * Compile a draft CausalRecipe from a causal finding.
   * Does not require replays and never writes CONFIRMED / RecipeSafe.
   */
  public compileDraft(input: PromotionEvaluateInput): CausalRecipe | null {
    const hasVerifiedEvidence = input.experiments.some(
      (record) => record.status === 'COMMITTED' && record.epochStillFresh && Boolean(record.completedWallMs)
    );
    if (!hasVerifiedEvidence || input.hypothesis.status === 'REFUTED') {
      return null;
    }
    return this.buildRecipe(input, 'DRAFT');
  }

  public evaluate(input: PromotionEvaluateInput): PromotionEvaluateResult {
    return this.evaluatePromotion(input);
  }

  public evaluatePromotion(input: PromotionEvaluateInput): PromotionEvaluateResult {
    const failedGates: PromotionGateName[] = [];
    const constraints = input.fingerprintConstraints ?? defaultConstraints(input.fingerprint);

    if (!this.safetyPass(input)) failedGates.push('safety');
    if (!this.statisticalPass(input)) failedGates.push('statistical');
    if (!this.replayPass(input)) failedGates.push('replay');
    if (!this.privacyPass(input)) failedGates.push('privacy');
    if (!this.fingerprintPass(constraints, input.fingerprint)) failedGates.push('fingerprint');
    if (!this.rollbackPass(input)) failedGates.push('rollback');

    if (failedGates.length > 0) {
      return { pass: false, failedGates };
    }

    const recipe = this.buildRecipe(input, 'RECIPE_SAFE', constraints);
    this.confirmHypothesis(input.hypothesis);
    return { pass: true, recipe };
  }

  /**
   * Sets CONFIRMED. Call only when evaluate() passed (or from evaluate itself).
   */
  public confirmHypothesis(hyp: CausalHypothesis): CausalHypothesis {
    hyp.status = 'CONFIRMED';
    return hyp;
  }

  /**
   * Replay a stored recipe against a later visit.
   * matching fingerprint + success → increment stableReplays
   * matching fingerprint + failure → Invalidated
   * origin/detector/structural mismatch → Invalidated immediately, do not apply
   * path-class mismatch → do not replay (do not assume equivalence)
   */
  public replay(
    recipe: CausalRecipe,
    fingerprint: PageFingerprint,
    healthDelta: number,
    success: boolean
  ): PromotionReplayResult {
    const prev = this.lifecycleById.get(recipe.id) ?? this.inferLifecycle(recipe);
    if (prev === 'INVALIDATED') {
      return { recipe: cloneRecipe(recipe), lifecycle: 'INVALIDATED', applied: false };
    }

    const constraints: Partial<PageFingerprint> = {
      originHash: recipe.originHash,
      ...recipe.fingerprintConstraints,
    };
    if (constraints.originHash === undefined) constraints.originHash = recipe.originHash;

    const fp = checkFingerprint(constraints, fingerprint);
    if (!fp.ok) {
      if (isIdentityMismatch(fp.kind) || fp.kind === 'MISSING_CONSTRAINT') {
        return this.invalidate(recipe);
      }
      // Path class / resource mismatch: do not assume equivalence, do not apply.
      return { recipe: cloneRecipe(recipe), lifecycle: prev, applied: false };
    }

    const healthOk = replayHealthOk(healthDelta, recipe.expectedHealthDelta);
    if (!success || !healthOk) {
      return this.invalidate(recipe);
    }

    const next = cloneRecipe(recipe);
    next.causalSupport = {
      ...next.causalSupport,
      stableReplays: next.causalSupport.stableReplays + 1,
    };
    this.lifecycleById.set(next.id, prev);
    return { recipe: next, lifecycle: prev, applied: true };
  }

  private inferLifecycle(recipe: CausalRecipe): CausalRecipeLifecycle {
    if (recipe.causalSupport.stableReplays >= RECIPE_SAFE_MIN_STABLE_REPLAYS) return 'RECIPE_SAFE';
    if (recipe.causalSupport.stableReplays >= 1) return 'CONFIRMED';
    return 'DRAFT';
  }

  private invalidate(recipe: CausalRecipe): PromotionReplayResult {
    const next = cloneRecipe(recipe);
    this.lifecycleById.set(next.id, 'INVALIDATED');
    return { recipe: next, lifecycle: 'INVALIDATED', applied: false };
  }

  private nextId(existing?: CausalRecipe['id']): CausalRecipe['id'] {
    if (existing !== undefined) return existing;
    if (this.store !== undefined) return this.store.allocateId();
    const id = recipeId(this.seq);
    this.seq += 1;
    return id;
  }

  private buildRecipe(
    input: PromotionEvaluateInput,
    lifecycle: CausalRecipeLifecycle,
    constraints?: Partial<PageFingerprint>
  ): CausalRecipe {
    const fpConstraints = constraints ?? input.fingerprintConstraints ?? defaultConstraints(input.fingerprint);
    const n = experimentCount(input);
    const recipe: CausalRecipe = {
      id: this.nextId(input.existingRecipeId),
      version: CAUSAL_RECIPE_VERSION,
      originHash: input.fingerprint.originHash,
      fingerprintConstraints: { ...fpConstraints },
      preconditions: input.preconditions !== undefined ? [...input.preconditions] : [],
      actionRefs: [...input.actionRefs],
      causalSupport: {
        hypothesisClass: input.hypothesis.mechanismClass,
        posterior: input.hypothesis.posterior,
        experiments: n,
        stableReplays: Math.min(input.stableReplays, derivedStableReplays(input)),
      },
      expectedHealthDelta: input.expectedHealthDelta,
      minPrivacyScore: Math.min(input.minPrivacyScore, derivedPrivacyScore(input)),
      rollbackPlanRef: input.rollbackPlanRef,
    };
    this.lifecycleById.set(recipe.id, lifecycle);
    return recipe;
  }

  private safetyPass(input: PromotionEvaluateInput): boolean {
    if (input.hypothesis.status !== 'SUPPORTED' && input.hypothesis.status !== 'CONFIRMED') {
      return false;
    }
    if (input.actions.length === 0) return false;
    for (const action of input.actions) {
      if (!REVERSIBLE_ACTION_TYPES.has(action.type)) return false;
      if (action.type === 'NET_ALLOW_EXCEPTION' && isNoopInvalidAllow(action.urlFilter)) return false;
      if (isPersistentTrackerAllow(action)) return false;
      if (hasForbiddenContext(actionText(action))) return false;
    }
    if (input.mappedStrategy !== undefined) {
      if (!input.mappedStrategy.isReversible) return false;
      if (hasForbiddenContext([input.mappedStrategy.name, input.mappedStrategy.rationale])) {
        return false;
      }
    }
    const extra: string[] = [...input.actionRefs];
    if (input.preconditions !== undefined) extra.push(...input.preconditions);
    if (hasForbiddenContext(extra)) return false;
    return true;
  }

  private statisticalPass(input: PromotionEvaluateInput): boolean {
    if (input.hypothesis.status !== 'SUPPORTED' && input.hypothesis.status !== 'CONFIRMED') {
      return false;
    }
    const n = experimentCount(input);
    if (n < DEFAULT_SEQUENTIAL_BOUNDS.supportMinN) return false;
    if (input.hypothesis.posterior < DEFAULT_SEQUENTIAL_BOUNDS.supportPosterior) return false;
    const verified = verifiedExperiments(input);
    const successes = verified.filter(
      (record) => (record.healthDelta ?? 0) >= DEFAULT_SEQUENTIAL_BOUNDS.minMeaningfulHealthDelta
    ).length;
    const ci = successRateCi95({ alpha: 1 + successes, beta: 1 + n - successes });
    if (ci[0] <= DEFAULT_SEQUENTIAL_BOUNDS.supportCiLower) return false;
    return true;
  }

  private replayPass(input: PromotionEvaluateInput): boolean {
    return Math.min(input.stableReplays, derivedStableReplays(input)) >= RECIPE_SAFE_MIN_STABLE_REPLAYS;
  }

  private privacyPass(input: PromotionEvaluateInput): boolean {
    if (Math.min(input.minPrivacyScore, derivedPrivacyScore(input)) < MIN_PRIVACY_SCORE_FOR_PROMOTION) return false;
    for (const action of input.actions) {
      if (isPersistentTrackerAllow(action)) return false;
    }
    if (input.mappedStrategy !== undefined) {
      for (const action of input.mappedStrategy.actions) {
        if (isPersistentTrackerAllow(action)) return false;
      }
    }
    return true;
  }

  private fingerprintPass(
    constraints: Partial<PageFingerprint>,
    incoming: PageFingerprint
  ): boolean {
    return checkFingerprint(constraints, incoming).ok;
  }

  private rollbackPass(input: PromotionEvaluateInput): boolean {
    if (input.rollbackPlanRef.length === 0) return false;
    const last = lastExperiment(input.experiments);
    if (last !== undefined && last.rollbackVerified) return true;
    for (const rec of input.experiments) {
      if (rec.status === 'COMMITTED' && rec.rollbackVerified) return true;
    }
    return false;
  }
}

export function allPromotionGates(): readonly PromotionGateName[] {
  return PROMOTION_GATES;
}
