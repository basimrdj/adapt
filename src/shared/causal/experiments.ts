/**
 * Phase 3 M3 — ExperimentCandidate (spec §11), scoring helpers, EvidencePacketV3
 * projection, and CausalPlannerDecisionV1 (spec §7.1 / §32).
 *
 * ExperimentRecord lives in events.ts (M1 stub); import it, do not duplicate.
 */

import {
  CausalHypothesis,
  EventKind,
  ExperimentBudget,
  HealthVectorCompact,
  OpaqueRef,
} from './events';

export const CAUSAL_PLAN_SCHEMA_VERSION = 'causal-plan-1' as const;
export const EVIDENCE_PACKET_SCHEMA_VERSION = '3.0' as const;

export const DURATION_NORM_MS = 8000;

export const UTILITY_WEIGHTS = Object.freeze({
  lambdaH: 1.0,
  lambdaP: 1.5,
  lambdaT: 0.2,
  lambdaR: 0.5,
});

/** Frozen Phase-1 strategy refs. Never invent selectors, URLs, or JS. */
export const STRATEGY_REF_ALLOWLIST = Object.freeze({
  NETWORK: 'strategy:s1',
  DOM_OVERLAY: 'strategy:s2',
  RESTORE_SCROLL: 'strategy:s3',
  PRESERVE_BAIT: 'strategy:s4',
  DOM_HIDE: 'strategy:s5',
} as const);

export type StrategyRefName = keyof typeof STRATEGY_REF_ALLOWLIST;

export const ALLOWED_INTERVENTION_VARIABLES = Object.freeze([
  'temp_network_exception',
  'preserve_bait_geometry',
  'remove_overlay_gate',
  'restore_scroll',
  'dom_hide_candidate',
] as const);

export type AllowedInterventionVariable = (typeof ALLOWED_INTERVENTION_VARIABLES)[number];

export const CAUSAL_REASON_CODES = Object.freeze([
  'MAX_INFORMATION_GAIN_SAFE',
  'INSUFFICIENT_EVIDENCE',
  'CONFOUNDING_TOO_HIGH',
  'RISK_TOO_HIGH',
  'HYPOTHESIS_CONFIRMED',
  'NO_VALID_EXPERIMENT',
] as const);

export type CausalReasonCode = (typeof CAUSAL_REASON_CODES)[number];

export const EXPECTED_OUTCOMES = Object.freeze(['IMPROVE', 'WORSEN', 'NO_CHANGE'] as const);
export type ExpectedOutcome = (typeof EXPECTED_OUTCOMES)[number];

export const FORBIDDEN_ACTION_KEYS = Object.freeze([
  'actions',
  'action',
  'selector',
  'css',
  'cssText',
  'javascript',
  'js',
  'script',
  'code',
  'url',
  'urlFilter',
  'parameter',
  'targetSelector',
  'html',
] as const);

const FORBIDDEN_TOKEN_RE =
  /form[_\s-]?submit|purchase|subscribe|login|logout|paywall|password|credential|auth[_\s-]?bypass/i;

export interface ExperimentCandidate {
  id: `experiment:x${number}`;
  hypothesisRef: `hypothesis:h${number}`;
  intervention: {
    variable: string;
    actionRefs: OpaqueRef[];
    desiredValue: string | number | boolean;
  };
  scope: {
    tabId: number;
    navigationEpoch: number;
    documentId: string;
    frameIds: number[];
  };
  expected: {
    informationGain: number;
    healthRisk: number;
    privacyRisk: number;
    rollbackConfidence: number;
    durationMs: number;
  };
  controls: {
    oneVariable: boolean;
    requiresReload: boolean;
    pairedBaselineAvailable: boolean;
  };
  rollbackPlanRef: string;
}

export interface InterventionTemplate {
  variable: AllowedInterventionVariable;
  strategyRef: OpaqueRef;
  healthRisk: number;
  privacyRisk: number;
  rollbackConfidence: number;
  durationMs: number;
  desiredValue: string | number | boolean;
}

export const MECHANISM_INTERVENTION_TEMPLATES: Readonly<
  Partial<Record<CausalHypothesis['mechanismClass'], InterventionTemplate>>
> = Object.freeze({
  BLOCKED_RESOURCE_PROBE: {
    variable: 'temp_network_exception',
    strategyRef: STRATEGY_REF_ALLOWLIST.NETWORK,
    healthRisk: 0.15,
    privacyRisk: 0.08,
    rollbackConfidence: 0.995,
    durationMs: 1500,
    desiredValue: true,
  },
  BAIT_VISIBILITY_PROBE: {
    variable: 'preserve_bait_geometry',
    strategyRef: STRATEGY_REF_ALLOWLIST.PRESERVE_BAIT,
    healthRisk: 0.08,
    privacyRisk: 0.02,
    rollbackConfidence: 0.998,
    durationMs: 1000,
    desiredValue: true,
  },
  OVERLAY_REINSERTION: {
    variable: 'remove_overlay_gate',
    strategyRef: STRATEGY_REF_ALLOWLIST.DOM_OVERLAY,
    healthRisk: 0.12,
    privacyRisk: 0.02,
    rollbackConfidence: 0.997,
    durationMs: 1200,
    desiredValue: false,
  },
  SCROLL_LOCK_REACTION: {
    variable: 'restore_scroll',
    strategyRef: STRATEGY_REF_ALLOWLIST.RESTORE_SCROLL,
    healthRisk: 0.1,
    privacyRisk: 0.01,
    rollbackConfidence: 0.998,
    durationMs: 800,
    desiredValue: true,
  },
  COSMETIC_REMOVAL_DEPENDENCY: {
    variable: 'dom_hide_candidate',
    strategyRef: STRATEGY_REF_ALLOWLIST.DOM_HIDE,
    healthRisk: 0.12,
    privacyRisk: 0.02,
    rollbackConfidence: 0.996,
    durationMs: 1200,
    desiredValue: true,
  },
});

export interface CurrentEpochState {
  tabId: number;
  navigationEpoch: number;
  documentId: string;
  frameId: number;
}

export interface ExperimentSelectionBudget extends ExperimentBudget {
  remaining: number;
}

export type CausalPlannerDecisionV1 =
  | {
      schemaVersion: 'causal-plan-1';
      decision: 'EXPERIMENT';
      experimentRef: `experiment:x${number}`;
      hypothesisRef: `hypothesis:h${number}`;
      reasonCode: CausalReasonCode;
      expectedOutcome?: ExpectedOutcome;
      confidence: number;
    }
  | {
      schemaVersion: 'causal-plan-1';
      decision: 'ABSTAIN';
      reasonCode: CausalReasonCode;
      expectedOutcome?: ExpectedOutcome;
      confidence: number;
    }
  | {
      schemaVersion: 'causal-plan-1';
      decision: 'PROMOTE_RECIPE';
      hypothesisRef: `hypothesis:h${number}`;
      reasonCode: CausalReasonCode;
      expectedOutcome?: ExpectedOutcome;
      confidence: number;
    };

export interface PacketObservation {
  ref: OpaqueRef;
  kind: EventKind;
  relativeOrder: number;
  timeBucketMs?: number;
  features: Record<string, string | number | boolean | null>;
  confidence: number;
}

export interface PacketHypothesis {
  ref: `hypothesis:h${number}`;
  causeRefs: OpaqueRef[];
  outcome: CausalHypothesis['outcome'];
  prior: number;
  posterior: number;
  evidenceFor: OpaqueRef[];
  evidenceAgainst: OpaqueRef[];
  confoundingRisk: CausalHypothesis['confoundingRisk'];
}

export interface PacketExperiment {
  ref: `experiment:x${number}`;
  actionRefs: OpaqueRef[];
  interventionVariable: string;
  expectedInformationGain: number;
  expectedHealthRisk: number;
  privacyRisk: number;
  rollbackConfidence: number;
  estimatedDurationMs: number;
  oneVariable: boolean;
}

export interface EvidencePacketV3 {
  schemaVersion: '3.0';
  packetId: string;
  scope: {
    tabRef: string;
    tabId: number;
    navigationEpoch: number;
    documentId: string;
    documentRef: `frame:f${number}`;
    originClass: 'firstParty' | 'thirdPartyMixed';
  };
  health: {
    baseline: HealthVectorCompact;
    current: HealthVectorCompact;
    delta: number;
    confidence: number;
  };
  observations: PacketObservation[];
  hypotheses: PacketHypothesis[];
  availableExperiments: PacketExperiment[];
  policy: {
    maxExperimentRisk: number;
    maxPrivacyRisk: number;
    remainingInterventions: number;
    maxWaitMs: number;
    requiresSingleVariable: boolean;
    minRollbackConfidence: number;
  };
}

export type CausalValidationResult =
  | { ok: true; decision: CausalPlannerDecisionV1 }
  | { ok: false; reason: string };

const STRATEGY_REF_SET: ReadonlySet<string> = new Set(Object.values(STRATEGY_REF_ALLOWLIST));
const ALLOWED_VARIABLE_SET: ReadonlySet<string> = new Set(ALLOWED_INTERVENTION_VARIABLES);
const REASON_CODE_SET: ReadonlySet<string> = new Set(CAUSAL_REASON_CODES);
const EXPECTED_OUTCOME_SET: ReadonlySet<string> = new Set(EXPECTED_OUTCOMES);

const OPAQUE_REF_RE =
  /^(event:.+|element:e\d+|request:r\d+|resource:res\d+|frame:f\d+|strategy:s\d+|hypothesis:h\d+|experiment:x\d+|recipe:rcp\d+)$/;

export function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function isOpaqueRefString(value: string): value is OpaqueRef {
  return OPAQUE_REF_RE.test(value);
}

export function isAllowedReasonCode(value: string): value is CausalReasonCode {
  return REASON_CODE_SET.has(value);
}

export function isAllowedExpectedOutcome(value: string): value is ExpectedOutcome {
  return EXPECTED_OUTCOME_SET.has(value);
}

export function isStrategyAllowlistRef(ref: OpaqueRef): boolean {
  return STRATEGY_REF_SET.has(ref);
}

export function containsForbiddenToken(value: string): boolean {
  return FORBIDDEN_TOKEN_RE.test(value);
}

export function looksLikeSelectorOrUrl(value: string): boolean {
  if (/^https?:\/\//i.test(value) || /^javascript:/i.test(value)) return true;
  if (/^[.#\[]/.test(value)) return true;
  if (value.includes('{') && value.includes('}')) return true;
  if (value.includes('document.') || value.includes('window.')) return true;
  return false;
}

export function scoreInformationGain(
  confoundingRisk: CausalHypothesis['confoundingRisk'],
  candidateHypothesisCount: number
): number {
  const base = confoundingRisk === 'LOW' ? 0.72 : confoundingRisk === 'MEDIUM' ? 0.48 : 0.22;
  const discriminating = candidateHypothesisCount > 1 ? 0.2 : 0;
  return clampUnit(base + discriminating);
}

export function experimentUtility(x: ExperimentCandidate): number {
  const ig = clampUnit(x.expected.informationGain);
  const durationNorm = Math.min(1, Math.max(0, x.expected.durationMs / DURATION_NORM_MS));
  return (
    ig -
    UTILITY_WEIGHTS.lambdaH * x.expected.healthRisk -
    UTILITY_WEIGHTS.lambdaP * x.expected.privacyRisk -
    UTILITY_WEIGHTS.lambdaT * durationNorm -
    UTILITY_WEIGHTS.lambdaR * (1 - x.expected.rollbackConfidence)
  );
}

export function isEpochFresh(
  scope: ExperimentCandidate['scope'],
  now: CurrentEpochState
): boolean {
  if (scope.tabId !== now.tabId) return false;
  if (scope.navigationEpoch !== now.navigationEpoch) return false;
  if (scope.documentId !== now.documentId) return false;
  if (scope.frameIds.length > 0 && !scope.frameIds.includes(now.frameId)) return false;
  return true;
}

export function isPolicyAllowed(x: ExperimentCandidate): boolean {
  if (!x.controls.oneVariable) return false;
  if (!ALLOWED_VARIABLE_SET.has(x.intervention.variable)) return false;
  if (containsForbiddenToken(x.intervention.variable)) return false;
  if (looksLikeSelectorOrUrl(x.intervention.variable)) return false;
  if (x.intervention.actionRefs.length === 0) return false;
  for (const ref of x.intervention.actionRefs) {
    if (!isOpaqueRefString(ref)) return false;
    if (containsForbiddenToken(ref) || looksLikeSelectorOrUrl(ref)) return false;
  }
  const hasStrategy = x.intervention.actionRefs.some((r) => isStrategyAllowlistRef(r));
  if (!hasStrategy) return false;
  return true;
}

export function withinBudgetCeilings(
  x: ExperimentCandidate,
  budget: ExperimentBudget
): boolean {
  if (x.expected.healthRisk > budget.maxHealthRisk) return false;
  if (x.expected.privacyRisk > budget.maxPrivacyRisk) return false;
  if (x.expected.rollbackConfidence < budget.minRollbackConfidence) return false;
  return true;
}

export function uniqueOpaqueRefs(refs: OpaqueRef[]): OpaqueRef[] {
  const seen = new Set<OpaqueRef>();
  const out: OpaqueRef[] = [];
  for (const r of refs) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

export function nextExperimentId(existingIds: ReadonlyArray<string>): `experiment:x${number}` {
  let max = 0;
  for (const id of existingIds) {
    if (!id.startsWith('experiment:x')) continue;
    const n = Number(id.slice('experiment:x'.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `experiment:x${max + 1}`;
}

const NEUTRAL_HEALTH: HealthVectorCompact = {
  contentAccess: 0.5,
  interaction: 0.5,
  scrollability: 0.5,
  visualObstruction: 0.5,
  mutationStability: 0.5,
  networkIntegrity: 0.5,
  privacyPreservation: 1,
  confidence: 1,
};

export function projectCandidateToPacket(c: ExperimentCandidate): PacketExperiment {
  return {
    ref: c.id,
    actionRefs: [...c.intervention.actionRefs],
    interventionVariable: c.intervention.variable,
    expectedInformationGain: c.expected.informationGain,
    expectedHealthRisk: c.expected.healthRisk,
    privacyRisk: c.expected.privacyRisk,
    rollbackConfidence: c.expected.rollbackConfidence,
    estimatedDurationMs: c.expected.durationMs,
    oneVariable: c.controls.oneVariable,
  };
}

export function projectHypothesisToPacket(h: CausalHypothesis): PacketHypothesis {
  return {
    ref: h.id,
    causeRefs: [...h.causeRefs],
    outcome: h.outcome,
    prior: h.prior,
    posterior: h.posterior,
    evidenceFor: [...h.createdFrom],
    evidenceAgainst: [],
    confoundingRisk: h.confoundingRisk,
  };
}

export interface MinimalPacketInput {
  now: CurrentEpochState;
  hypotheses: CausalHypothesis[];
  experiments: ExperimentCandidate[];
  policy?: Partial<EvidencePacketV3['policy']>;
  packetId?: string;
  originClass?: EvidencePacketV3['scope']['originClass'];
  health?: EvidencePacketV3['health'];
  observations?: PacketObservation[];
}

export function buildMinimalPacket(input: MinimalPacketInput): EvidencePacketV3 {
  const policy: EvidencePacketV3['policy'] = {
    maxExperimentRisk: input.policy?.maxExperimentRisk ?? 0.2,
    maxPrivacyRisk: input.policy?.maxPrivacyRisk ?? 0.1,
    remainingInterventions: input.policy?.remainingInterventions ?? 3,
    maxWaitMs: input.policy?.maxWaitMs ?? DURATION_NORM_MS,
    requiresSingleVariable: input.policy?.requiresSingleVariable ?? true,
    minRollbackConfidence: input.policy?.minRollbackConfidence ?? 0.995,
  };
  return {
    schemaVersion: EVIDENCE_PACKET_SCHEMA_VERSION,
    packetId: input.packetId ?? 'packet:test',
    scope: {
      tabRef: `tab:${input.now.tabId}`,
      tabId: input.now.tabId,
      navigationEpoch: input.now.navigationEpoch,
      documentId: input.now.documentId,
      documentRef: `frame:f${input.now.frameId}`,
      originClass: input.originClass ?? 'firstParty',
    },
    health: input.health ?? {
      baseline: { ...NEUTRAL_HEALTH },
      current: { ...NEUTRAL_HEALTH },
      delta: 0,
      confidence: 1,
    },
    observations: input.observations ?? [],
    hypotheses: input.hypotheses.map(projectHypothesisToPacket),
    availableExperiments: input.experiments.map(projectCandidateToPacket),
    policy,
  };
}
