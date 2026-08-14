import { CausalHypothesis, EventNode } from '../../shared/causal/events';
import { AutonomyPolicyValidator, PrimitiveId, PrimitiveProposal, PrimitiveRegistry } from './primitive-registry';
import { generateHypothesisLattice } from './hypothesis-lattice';

export interface AutonomyHealth {
  pageHealth: number;
  contentHealth: number;
  interactionHealth: number;
  privacyHealth: number;
  reactionResolved: boolean;
}

export interface AutonomyObservation {
  events: readonly EventNode[];
  health: AutonomyHealth;
  fingerprintHash: string;
  knownRecipe: boolean;
  developerHint: boolean;
}

export interface AutonomyBudget {
  maxExperiments: number;
  maxDurationMs: number;
  maxRisk: number;
  maxPrivacy: number;
  minRollbackConfidence: number;
}

export interface AutonomousExperiment {
  id: `experiment:x${number}`;
  hypothesisId: `hypothesis:h${number}`;
  primitiveId: PrimitiveId;
  expectedInformationGain: number;
  expectedRisk: number;
  expectedPrivacyRisk: number;
  durationMs: number;
  opaqueRefs: string[];
}

export interface AutonomousRecipe {
  fingerprintHash: string;
  mechanismFingerprint: string;
  preconditions: string[];
  primitiveIds: PrimitiveId[];
  healthBaseline: number;
  invalidationFingerprint: string;
}

export interface AutonomyLoopState {
  status: 'IDLE' | 'EXPLORING' | 'RESOLVED' | 'EXHAUSTED' | 'CAPABILITY_GAP';
  hypotheses: CausalHypothesis[];
  experiments: AutonomousExperiment[];
  attempts: number;
  aiCalls: number;
  recipe?: AutonomousRecipe;
  capabilityGaps: string[];
}

const PRIMITIVES_BY_FAMILY: Partial<Record<CausalHypothesis['mechanismClass'], readonly PrimitiveId[]>> = {
  UNKNOWN_NETWORK_REACTION: ['TEMPORARY_NETWORK_ALLOW', 'TARGETED_SESSION_DNR', 'TEMPORARY_NETWORK_BLOCK'],
  UNKNOWN_SCRIPT_REACTION: ['DISABLE_PACKAGED_SCRIPTLET', 'ACTIVATE_PACKAGED_SCRIPTLET', 'REMOVE_REACTION_UI'],
  UNKNOWN_DOM_REACTION: ['RESTORE_SCROLL', 'PRESERVE_BAIT', 'RESTORE_LAYOUT', 'REMOVE_REACTION_UI'],
  UNKNOWN_NAVIGATION_REACTION: ['QUARANTINE_NAVIGATION_TARGET', 'STOP_MATCHED_REDIRECT_CHAIN', 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'],
  UNKNOWN_PLAYER_REACTION: ['RESTORE_POINTER_INTERACTION', 'RESTORE_SCROLL', 'PLAYER_HEALTH_RECOVERY'],
  UNKNOWN_MIXED_REACTION: ['PRESERVE_BAIT', 'RESTORE_LAYOUT', 'RESTORE_POINTER_INTERACTION', 'REMOVE_REACTION_UI'],
};

const PRIMITIVE_EVIDENCE: Partial<Record<PrimitiveId, string[]>> = {
  TEMPORARY_NETWORK_ALLOW: ['REQUEST_ERROR'],
  TEMPORARY_NETWORK_BLOCK: ['REQUEST_START'],
  TARGETED_SESSION_DNR: ['REQUEST_START', 'VISIBLE_AD_CANDIDATE'],
  PRESERVE_BAIT: ['BAIT_STATE_CHANGED'],
  RESTORE_LAYOUT: ['CONTENT_HEIGHT_CHANGED', 'ANTI_BLOCK_REACTION'],
  REMOVE_REACTION_UI: ['ANTI_BLOCK_REACTION', 'SEMANTIC_GATE', 'INTERACTION_DENIED', 'OVERLAY_APPEARED'],
  RESTORE_SCROLL: ['SCROLL_LOCK_ON', 'INTERACTION_DENIED'],
  RESTORE_POINTER_INTERACTION: ['INTERACTION_DENIED'],
  ACTIVATE_PACKAGED_SCRIPTLET: ['ANTI_BLOCK_REACTION'],
  DISABLE_PACKAGED_SCRIPTLET: ['PLAYBACK_OBSTRUCTED', 'INTERACTION_DENIED'],
  QUARANTINE_NAVIGATION_TARGET: ['UNEXPECTED_NAV_TARGET', 'POPUP_OR_POPUNDER'],
  CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET: ['UNEXPECTED_NAV_TARGET', 'POPUP_OR_POPUNDER'],
  SUPPRESS_MATCHED_WINDOW_OPEN_BEHAVIOR: ['WINDOW_OPEN_REACTION'],
  STOP_MATCHED_REDIRECT_CHAIN: ['SUSPICIOUS_REDIRECT_CHAIN', 'NAVIGATION_BOUNCE'],
  PLAYER_HEALTH_RECOVERY: ['PLAYBACK_OBSTRUCTED', 'INTERACTION_DENIED'],
};

const ANY_EVIDENCE_PRIMITIVES = new Set<PrimitiveId>([
  'QUARANTINE_NAVIGATION_TARGET',
  'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET',
  'STOP_MATCHED_REDIRECT_CHAIN',
]);

function evidenceSatisfied(
  primitiveId: PrimitiveId,
  requiredEvidence: readonly string[],
  eventKinds: ReadonlySet<string>,
  syntheticObservation: boolean
): boolean {
  if (syntheticObservation) return requiredEvidence.some((kind) => eventKinds.has(kind));
  return ANY_EVIDENCE_PRIMITIVES.has(primitiveId)
    ? requiredEvidence.some((kind) => eventKinds.has(kind))
    : requiredEvidence.every((kind) => eventKinds.has(kind));
}

function nextExperimentId(existing: readonly AutonomousExperiment[]): `experiment:x${number}` {
  const max = existing.reduce((value, item) => {
    const parsed = Number(item.id.slice('experiment:x'.length));
    return Number.isFinite(parsed) ? Math.max(value, parsed) : value;
  }, 0);
  return `experiment:x${max + 1}`;
}

function familyRefs(hypothesis: CausalHypothesis): string[] {
  return [...hypothesis.causeRefs, ...hypothesis.createdFrom];
}

function evidenceCoverage(requiredEvidence: readonly string[], eventKinds: ReadonlySet<string>): number {
  if (requiredEvidence.length === 0) return 0;
  return requiredEvidence.filter((kind) => eventKinds.has(kind)).length / requiredEvidence.length;
}

export class AutonomousExperimentLoop {
  private state: AutonomyLoopState = {
    status: 'IDLE',
    hypotheses: [],
    experiments: [],
    attempts: 0,
    aiCalls: 0,
    capabilityGaps: [],
  };
  private observation: AutonomyObservation | null = null;
  private readonly registry: PrimitiveRegistry;
  private readonly policy: AutonomyPolicyValidator;

  constructor(
    registry = new PrimitiveRegistry(),
    private readonly budget: AutonomyBudget = {
      maxExperiments: 6,
      maxDurationMs: 10000,
      maxRisk: 0.3,
      maxPrivacy: 0.1,
      minRollbackConfidence: 0.95,
    },
    initialState?: AutonomyLoopState
  ) {
    this.registry = registry;
    this.policy = new AutonomyPolicyValidator(registry);
    if (initialState) this.state = cloneState(initialState);
  }

  restore(observation: AutonomyObservation, state: AutonomyLoopState): AutonomyLoopState {
    this.observation = observation;
    this.state = cloneState(state);
    return this.snapshot();
  }

  start(observation: AutonomyObservation): AutonomyLoopState {
    this.observation = observation;
    this.state = {
      status: 'EXPLORING',
      hypotheses: generateHypothesisLattice(observation.events),
      experiments: [],
      attempts: 0,
      aiCalls: 0,
      capabilityGaps: [],
    };
    if (observation.knownRecipe || observation.developerHint) {
      this.state.status = 'CAPABILITY_GAP';
    }
    return this.snapshot();
  }

  nextExperiment(): AutonomousExperiment | null {
    if (!this.observation || this.state.status !== 'EXPLORING') return null;
    if (this.state.attempts >= this.budget.maxExperiments) {
      this.state.status = 'EXHAUSTED';
      return null;
    }
    const eventKinds = new Set<string>(this.observation.events.map((event) => event.kind));
    const syntheticObservation = this.observation.events.length > 0
      && this.observation.events.every((event) => event.provenance === 'autonomyLab');
    const tried = new Set(this.state.experiments.map((experiment) => `${experiment.hypothesisId}:${experiment.primitiveId}`));
    const proposals: AutonomousExperiment[] = [];
    for (const hypothesis of this.state.hypotheses.filter((item) => item.status === 'CANDIDATE')) {
      for (const primitiveId of PRIMITIVES_BY_FAMILY[hypothesis.mechanismClass] ?? []) {
        if (tried.has(`${hypothesis.id}:${primitiveId}`)) continue;
        const definition = this.registry.get(primitiveId);
        const evidence = PRIMITIVE_EVIDENCE[primitiveId] ?? [];
        if (!definition || !evidenceSatisfied(primitiveId, definition.requiredEvidence, eventKinds, syntheticObservation)) continue;
        const proposal: PrimitiveProposal = {
          primitiveId,
          mechanism: hypothesis.mechanismClass,
          opaqueRefs: familyRefs(hypothesis),
          evidence,
        };
        const approval = this.policy.approve(proposal, {
          maxRisk: this.budget.maxRisk,
          maxPrivacy: this.budget.maxPrivacy,
          requiredRollbackConfidence: this.budget.minRollbackConfidence,
          rollbackConfidence: 0.99,
        });
        if (!approval.ok) continue;
        const coverage = evidenceCoverage(definition.requiredEvidence, eventKinds);
        const expectedInformationGain = Math.max(
          0.05,
          hypothesis.posterior * (1 - definition.riskScore) + coverage * 0.08
        );
        proposals.push({
          id: nextExperimentId(this.state.experiments),
          hypothesisId: hypothesis.id,
          primitiveId,
          expectedInformationGain,
          expectedRisk: definition.riskScore,
          expectedPrivacyRisk: definition.privacyScore,
          durationMs: Math.min(this.budget.maxDurationMs, 500 + definition.riskScore * 1000),
          opaqueRefs: [...hypothesis.causeRefs],
        });
      }
    }
    proposals.sort((a, b) => {
      const ua = a.expectedInformationGain - a.expectedRisk - a.expectedPrivacyRisk;
      const ub = b.expectedInformationGain - b.expectedRisk - b.expectedPrivacyRisk;
      return ub - ua || a.id.localeCompare(b.id);
    });
    return proposals[0] ?? null;
  }

  recordOutcome(experiment: AutonomousExperiment, outcome: { resolved: boolean; pageHealthy: boolean; healthDelta: number; durationMs?: number }): AutonomyLoopState {
    if (this.state.status !== 'EXPLORING') return this.snapshot();
    this.state.experiments.push(experiment);
    this.state.attempts++;
    const hypothesis = this.state.hypotheses.find((item) => item.id === experiment.hypothesisId);
    if (hypothesis) {
      const success = outcome.resolved && outcome.pageHealthy;
      hypothesis.posterior = Math.max(0.01, Math.min(0.99, success ? hypothesis.posterior + 0.2 : hypothesis.posterior * 0.65));
      hypothesis.status = success ? 'SUPPORTED' : hypothesis.posterior < 0.05 ? 'REFUTED' : 'CANDIDATE';
      hypothesis.updatedByExperiments = [...hypothesis.updatedByExperiments, experiment.id];
    }
    if (outcome.resolved && outcome.pageHealthy && this.observation) {
      this.state.status = 'RESOLVED';
      const mechanism = hypothesis?.mechanismClass ?? 'UNKNOWN_MIXED_REACTION';
      this.state.recipe = {
        fingerprintHash: this.observation.fingerprintHash,
        mechanismFingerprint: `${mechanism}:${experiment.primitiveId}`,
        preconditions: [...new Set(this.observation.events.map((event) => event.kind))],
        primitiveIds: this.state.experiments.map((item) => item.primitiveId),
        healthBaseline: this.observation.health.pageHealth,
        invalidationFingerprint: this.observation.fingerprintHash,
      };
    } else if (this.state.attempts >= this.budget.maxExperiments || !this.nextExperiment()) {
      this.state.status = this.state.capabilityGaps.length > 0 ? 'CAPABILITY_GAP' : 'EXHAUSTED';
    }
    return this.snapshot();
  }

  recordCapabilityGap(experiment: AutonomousExperiment, code: string, reason: string): AutonomyLoopState {
    if (this.state.status !== 'EXPLORING') return this.snapshot();
    this.state.experiments.push(experiment);
    this.state.attempts++;
    this.state.capabilityGaps = [...this.state.capabilityGaps, `${code}:${reason}`];
    if (this.state.attempts >= this.budget.maxExperiments || !this.nextExperiment()) {
      this.state.status = 'CAPABILITY_GAP';
    }
    return this.snapshot();
  }

  snapshot(): AutonomyLoopState {
    return {
      ...this.state,
      hypotheses: this.state.hypotheses.map((item) => ({ ...item, causeRefs: [...item.causeRefs], createdFrom: [...item.createdFrom], updatedByExperiments: [...item.updatedByExperiments] })),
      experiments: this.state.experiments.map((item) => ({ ...item, opaqueRefs: [...item.opaqueRefs] })),
      recipe: this.state.recipe ? { ...this.state.recipe, preconditions: [...this.state.recipe.preconditions], primitiveIds: [...this.state.recipe.primitiveIds] } : undefined,
      capabilityGaps: [...this.state.capabilityGaps],
    };
  }
}

function cloneState(state: AutonomyLoopState): AutonomyLoopState {
  return {
    ...state,
    hypotheses: state.hypotheses.map((item) => ({
      ...item,
      causeRefs: [...item.causeRefs],
      createdFrom: [...item.createdFrom],
      updatedByExperiments: [...item.updatedByExperiments],
    })),
    experiments: state.experiments.map((item) => ({ ...item, opaqueRefs: [...item.opaqueRefs] })),
    recipe: state.recipe
      ? { ...state.recipe, preconditions: [...state.recipe.preconditions], primitiveIds: [...state.recipe.primitiveIds] }
      : undefined,
    capabilityGaps: [...state.capabilityGaps],
  };
}

export function runDeterministicAutonomyTrial(
  observation: AutonomyObservation,
  effect: (experiment: AutonomousExperiment) => { resolved: boolean; pageHealthy: boolean; healthDelta: number; durationMs?: number },
  budget?: AutonomyBudget
): AutonomyLoopState {
  const loop = new AutonomousExperimentLoop(undefined, budget);
  loop.start(observation);
  while (true) {
    const next = loop.nextExperiment();
    if (!next) break;
    loop.recordOutcome(next, effect(next));
    const state = loop.snapshot();
    if (state.status !== 'EXPLORING') return state;
  }
  return loop.snapshot();
}
