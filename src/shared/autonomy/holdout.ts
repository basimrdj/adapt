import { EventNode, EventKind } from '../causal/events';
import { AutonomousExperiment, AutonomyObservation, AutonomyLoopState, runDeterministicAutonomyTrial } from '../../background/autonomy/saei';
import { PrimitiveId } from '../../background/autonomy/primitive-registry';

export type HoldoutSplit = 'TRAIN' | 'HOLDOUT';

export interface HoldoutScenario {
  id: string;
  split: HoldoutSplit;
  seed: number;
  eventKinds: EventKind[];
  requiredPrimitive: PrimitiveId | null;
  benign: boolean;
  pageHealth: number;
}

export interface HoldoutTrialResult {
  scenarioId: string;
  split: HoldoutSplit;
  benign: boolean;
  detected: boolean;
  resolved: boolean;
  falsePositive: boolean;
  experiments: number;
  timeToResolutionMs: number | null;
  recipeReplaySuccess: boolean;
  secondVisitAiCalls: number;
  capabilityGap: boolean;
}

export interface AutonomyScore {
  autonomousDetectionRate: number;
  autonomousResolutionRate: number;
  falsePositiveRate: number;
  medianExperiments: number;
  p95Experiments: number;
  medianTimeToResolutionMs: number | null;
  recipeReplaySuccessRate: number;
  secondVisitAiCalls: number;
  capabilityGaps: number;
}

const ACTIVE_EVENT_COMBINATIONS: readonly EventKind[][] = [
  ['REQUEST_ERROR', 'NETWORK_PROBE_REACTION'],
  ['BAIT_STATE_CHANGED', 'ANTI_BLOCK_REACTION'],
  ['SEMANTIC_GATE', 'INTERACTION_DENIED'],
  ['PLAYBACK_OBSTRUCTED', 'INTERACTION_DENIED'],
  ['UNEXPECTED_NAV_TARGET', 'POPUP_OR_POPUNDER'],
  ['SUSPICIOUS_REDIRECT_CHAIN', 'NAVIGATION_BOUNCE'],
  ['REPEATED_REINSERTION', 'CONTENT_HEIGHT_CHANGED', 'ANTI_BLOCK_REACTION'],
  ['ANTI_BLOCK_REACTION', 'PLAYBACK_OBSTRUCTED', 'UNKNOWN_REACTION'],
];

const REQUIRED_PRIMITIVES: readonly PrimitiveId[] = [
  'TEMPORARY_NETWORK_ALLOW',
  'PRESERVE_BAIT',
  'REMOVE_REACTION_UI',
  'PLAYER_HEALTH_RECOVERY',
  'QUARANTINE_NAVIGATION_TARGET',
  'STOP_MATCHED_REDIRECT_CHAIN',
  'RESTORE_LAYOUT',
  'DISABLE_PACKAGED_SCRIPTLET',
];

function random(seed: number): number {
  let value = seed >>> 0;
  value = Math.imul(value ^ (value >>> 16), 2246822507);
  value = Math.imul(value ^ (value >>> 13), 3266489909);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function event(id: string, kind: EventKind, index: number): EventNode {
  return {
    id: `event:${id}_${index}`,
    kind,
    scope: { tabId: 1, navigationEpoch: 1, documentId: `holdout-${id}`, frameId: 0, originHash: 'holdout' },
    timestamp: { value: index * 10, domain: 'extension.monotonic_ms' },
    refs: [],
    features: {},
    provenance: 'autonomyLab',
    observationConfidence: 1,
  };
}

function requiredPrimitiveFor(eventKinds: readonly EventKind[]): PrimitiveId | null {
  if (eventKinds.includes('REQUEST_ERROR')) return 'TEMPORARY_NETWORK_ALLOW';
  if (eventKinds.includes('BAIT_STATE_CHANGED')) return 'PRESERVE_BAIT';
  if (eventKinds.includes('PLAYBACK_OBSTRUCTED')) return 'PLAYER_HEALTH_RECOVERY';
  if (eventKinds.includes('POPUP_OR_POPUNDER')) return 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET';
  if (eventKinds.includes('SUSPICIOUS_REDIRECT_CHAIN')) return 'STOP_MATCHED_REDIRECT_CHAIN';
  if (eventKinds.includes('REPEATED_REINSERTION')) return 'RESTORE_LAYOUT';
  if (eventKinds.includes('SEMANTIC_GATE')) return 'REMOVE_REACTION_UI';
  return 'REMOVE_REACTION_UI';
}

export function generateAutonomyScenarios(seed = 35, count = 128, split: HoldoutSplit = 'HOLDOUT'): HoldoutScenario[] {
  const scenarios: HoldoutScenario[] = [];
  for (let index = 0; index < count; index++) {
    const scenarioSeed = seed + index * 7919;
    const benign = random(scenarioSeed) < 0.18;
    const combination = benign
      ? (random(scenarioSeed + 1) < 0.5 ? ['USER_INTENT', 'NAV_COMMIT'] as EventKind[] : ['DOM_READY', 'LOAD'] as EventKind[])
      : ACTIVE_EVENT_COMBINATIONS[Math.floor(random(scenarioSeed + 2) * ACTIVE_EVENT_COMBINATIONS.length)] ?? ['UNKNOWN_REACTION'];
    scenarios.push({
      id: `${split.toLowerCase()}-${index.toString(16).padStart(4, '0')}`,
      split,
      seed: scenarioSeed,
      eventKinds: [...combination],
      requiredPrimitive: benign ? null : requiredPrimitiveFor(combination),
      benign,
      pageHealth: benign ? 0.95 : 0.7 + random(scenarioSeed + 3) * 0.2,
    });
  }
  return scenarios;
}

function replay(state: AutonomyLoopState, scenario: HoldoutScenario): boolean {
  if (!state.recipe || state.status !== 'RESOLVED') return false;
  if (!scenario.requiredPrimitive) return false;
  return state.recipe.primitiveIds.includes(scenario.requiredPrimitive);
}

export function runHoldoutScenario(scenario: HoldoutScenario): HoldoutTrialResult {
  const observation: AutonomyObservation = {
    events: scenario.eventKinds.map((kind, index) => event(scenario.id, kind, index)),
    health: {
      pageHealth: scenario.pageHealth,
      contentHealth: scenario.pageHealth,
      interactionHealth: scenario.pageHealth,
      privacyHealth: 1,
      reactionResolved: scenario.benign,
    },
    fingerprintHash: `fingerprint:${scenario.seed}`,
    knownRecipe: false,
    developerHint: false,
  };
  const detected = scenario.eventKinds.some((kind) => !['USER_INTENT', 'NAV_COMMIT', 'DOM_READY', 'LOAD'].includes(kind));
  const state = runDeterministicAutonomyTrial(observation, (experiment: AutonomousExperiment) => {
    const success = !scenario.benign && experiment.primitiveId === scenario.requiredPrimitive;
    return {
      resolved: success,
      pageHealthy: scenario.benign || success,
      healthDelta: success ? 0.2 : -0.01,
      durationMs: 500 + experiment.expectedRisk * 1000,
    };
  });
  const resolved = scenario.benign ? state.status === 'IDLE' || state.status === 'EXHAUSTED' : state.status === 'RESOLVED';
  return {
    scenarioId: scenario.id,
    split: scenario.split,
    benign: scenario.benign,
    detected,
    resolved,
    falsePositive: scenario.benign && state.experiments.length > 0,
    experiments: state.experiments.length,
    timeToResolutionMs: resolved && !scenario.benign ? state.experiments.reduce((sum, item) => sum + item.durationMs, 0) : null,
    recipeReplaySuccess: !scenario.benign && replay(state, scenario),
    secondVisitAiCalls: 0,
    capabilityGap: state.status === 'CAPABILITY_GAP',
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? null;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

export function scoreAutonomy(results: readonly HoldoutTrialResult[]): AutonomyScore {
  const active = results.filter((result) => !result.benign);
  const benign = results.filter((result) => result.benign);
  const experimentCounts = active.map((result) => result.experiments);
  const durations = active.flatMap((result) => result.timeToResolutionMs === null ? [] : [result.timeToResolutionMs]);
  return {
    autonomousDetectionRate: active.length === 0 ? 1 : active.filter((result) => result.detected).length / active.length,
    autonomousResolutionRate: active.length === 0 ? 1 : active.filter((result) => result.resolved).length / active.length,
    falsePositiveRate: benign.length === 0 ? 0 : benign.filter((result) => result.falsePositive).length / benign.length,
    medianExperiments: median(experimentCounts) ?? 0,
    p95Experiments: percentile(experimentCounts, 0.95),
    medianTimeToResolutionMs: median(durations),
    recipeReplaySuccessRate: active.length === 0 ? 1 : active.filter((result) => result.recipeReplaySuccess).length / active.length,
    secondVisitAiCalls: results.reduce((sum, result) => sum + result.secondVisitAiCalls, 0),
    capabilityGaps: results.filter((result) => result.capabilityGap).length,
  };
}

export { REQUIRED_PRIMITIVES };
