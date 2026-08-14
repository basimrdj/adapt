import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventNode } from '../src/shared/causal/events';
import { PrimitiveRegistry } from '../src/background/autonomy/primitive-registry';
import { AutonomousExperimentLoop } from '../src/background/autonomy/saei';
import { generateAutonomyScenarios, runHoldoutScenario, scoreAutonomy } from '../src/shared/autonomy/holdout';

function run(command: string, args: string[]): void {
  execFileSync(command, args, {
    cwd: resolve(process.cwd()),
    env: { ...process.env, ADAPT_PHASE31_OFFLINE: process.env.ADAPT_PHASE31_OFFLINE ?? '1' },
    stdio: 'inherit',
  });
}

function knownCaseAiCalls(): number {
  const event: EventNode = {
    id: 'event:known-case', kind: 'ANTI_BLOCK_REACTION',
    scope: { tabId: 1, navigationEpoch: 1, documentId: 'known', frameId: 0, originHash: 'known' },
    timestamp: { value: 1, domain: 'extension.monotonic_ms' }, refs: [], features: {},
    provenance: 'autonomyLab', observationConfidence: 1,
  };
  const loop = new AutonomousExperimentLoop();
  return loop.start({
    events: [event],
    health: { pageHealth: 0.95, contentHealth: 0.95, interactionHealth: 0.95, privacyHealth: 1, reactionResolved: true },
    fingerprintHash: 'known', knownRecipe: true, developerHint: false,
  }).aiCalls;
}

run('npm', ['run', 'verify:phase31b']);
run('npx', ['vitest', 'run', 'tests/unit/autonomy']);

const registry = new PrimitiveRegistry();
const results = generateAutonomyScenarios(350, 128, 'HOLDOUT').map(runHoldoutScenario);
const score = scoreAutonomy(results);
const syntheticFailures: string[] = [];
if (score.autonomousDetectionRate < 0.95) syntheticFailures.push('autonomous_detection_rate < 0.95');
if (score.autonomousResolutionRate < 0.9) syntheticFailures.push('autonomous_resolution_rate < 0.90');
if (score.falsePositiveRate !== 0) syntheticFailures.push('false_positive_rate != 0');
const report = {
  schema: 'adapt-phase35b-synthetic-autonomy-v1',
  phase31b: 'PASS',
  verdict: syntheticFailures.length === 0 ? 'PASS' : 'FAIL',
  unseenTrials: results.length,
  sensorCoverage: 14,
  primitiveCount: registry.list().length,
  autonomous_detection_rate: score.autonomousDetectionRate,
  autonomous_resolution_rate: score.autonomousResolutionRate,
  false_positive_rate: score.falsePositiveRate,
  median_experiments: score.medianExperiments,
  p95_experiments: score.p95Experiments,
  median_time_to_resolution_ms: score.medianTimeToResolutionMs,
  recipe_replay_success_rate: score.recipeReplaySuccessRate,
  second_visit_ai_calls: score.secondVisitAiCalls,
  known_case_ai_calls: knownCaseAiCalls(),
  capability_gaps: score.capabilityGaps,
  negative_controls: results.filter((result) => result.benign).length,
  synthetic_failures: syntheticFailures,
  real_browser_autonomy_score: null,
};

const outputDir = resolve(process.cwd(), 'artifacts/phase35');
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'AUTONOMY_SCORE.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`AUTONOMY_SCORE: ${JSON.stringify(report)}`);
if (syntheticFailures.length > 0) {
  throw new Error(`PHASE 3.5B SYNTHETIC AUTONOMY VERIFICATION: FAIL (${syntheticFailures.join(', ')})`);
}
console.log('SYNTHETIC ALGORITHMIC AUTONOMY VERIFICATION: PASS');
