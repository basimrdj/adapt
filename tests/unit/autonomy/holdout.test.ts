import { describe, expect, it } from 'vitest';
import { generateAutonomyScenarios, runHoldoutScenario, scoreAutonomy } from '../../../src/shared/autonomy/holdout';

describe('autonomous holdout lab', () => {
  it('keeps holdout expectations outside the runtime observation', () => {
    const scenarios = generateAutonomyScenarios(351, 32, 'HOLDOUT');
    expect(scenarios).toHaveLength(32);
    expect(scenarios.every((scenario) => scenario.id.startsWith('holdout-'))).toBe(true);
    expect(scenarios.some((scenario) => scenario.requiredPrimitive !== null)).toBe(true);
  });

  it('measures detection, resolution, replay, and negative controls', () => {
    const results = generateAutonomyScenarios(352, 48, 'HOLDOUT').map(runHoldoutScenario);
    const score = scoreAutonomy(results);
    expect(score.autonomousDetectionRate).toBe(1);
    expect(score.autonomousResolutionRate).toBeGreaterThan(0.7);
    expect(score.falsePositiveRate).toBe(0);
    expect(score.secondVisitAiCalls).toBe(0);
  });
});
