import { describe, it, expect } from 'vitest';
import { verifyHealthOutcome } from '../../src/core/health/compare';
import { HealthVector } from '../../src/shared/types';

describe('Health Comparator', () => {
  const brokenBaseline: HealthVector = {
    antiBlockReaction: 0.85,
    contentAvailability: 0.60,
    interaction: 0.20,
    scrollability: 0.10,
    navigationHealth: 1.0,
    visualObstruction: 0.90,
    mutationStability: 1.0,
    confidence: 0.90,
  };

  it('declares success when reaction drops and content & interaction are restored', () => {
    const postHealth: HealthVector = {
      antiBlockReaction: 0.05,
      contentAvailability: 0.95,
      interaction: 1.0,
      scrollability: 1.0,
      navigationHealth: 1.0,
      visualObstruction: 0.0,
      mutationStability: 1.0,
      confidence: 0.90,
    };

    const result = verifyHealthOutcome(brokenBaseline, postHealth);
    expect(result.success).toBe(true);
    expect(result.reactionDelta).toBeLessThan(-0.70);
    expect(result.scoreDelta).toBeGreaterThan(0.40);
  });

  it('rejects adaptation if content regresses', () => {
    const postBrokenContent: HealthVector = {
      antiBlockReaction: 0.05,
      contentAvailability: 0.20, // Major regression
      interaction: 1.0,
      scrollability: 1.0,
      navigationHealth: 1.0,
      visualObstruction: 0.0,
      mutationStability: 1.0,
      confidence: 0.90,
    };

    const result = verifyHealthOutcome(brokenBaseline, postBrokenContent);
    expect(result.success).toBe(false);
    expect(result.notes).toContain('regressed');
  });

  it('rejects adaptation if interaction remains locked', () => {
    const postLocked: HealthVector = {
      antiBlockReaction: 0.10,
      contentAvailability: 0.90,
      interaction: 0.10, // Still blocked
      scrollability: 0.10,
      navigationHealth: 1.0,
      visualObstruction: 0.0,
      mutationStability: 1.0,
      confidence: 0.90,
    };

    const result = verifyHealthOutcome(brokenBaseline, postLocked);
    expect(result.success).toBe(false);
    expect(result.notes).toContain('interaction or scrollability remained locked');
  });
});
