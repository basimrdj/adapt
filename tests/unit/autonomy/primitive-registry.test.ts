import { describe, expect, it } from 'vitest';
import { AutonomyPolicyValidator, PrimitiveRegistry } from '../../../src/background/autonomy/primitive-registry';

describe('autonomous primitive registry', () => {
  it('ships the bounded primitive surface without executable source', () => {
    const registry = new PrimitiveRegistry();
    const ids = registry.list().map((item) => item.id);
    expect(ids).toContain('QUARANTINE_NAVIGATION_TARGET');
    expect(ids).toContain('CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET');
    expect(ids).toContain('PLAYER_HEALTH_RECOVERY');
    expect(registry.list().every((item) => item.executionWorld !== 'main-world' || !item.id.includes('JS'))).toBe(true);
  });

  it('rejects raw selectors, URLs, and forbidden contexts', () => {
    const registry = new PrimitiveRegistry();
    expect(registry.validate({
      primitiveId: 'QUARANTINE_NAVIGATION_TARGET',
      mechanism: 'UNKNOWN_NAVIGATION_REACTION',
      opaqueRefs: ['.popup'],
      evidence: ['UNEXPECTED_NAV_TARGET'],
    }).ok).toBe(false);
    expect(registry.validate({
      primitiveId: 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET',
      mechanism: 'UNKNOWN_NAVIGATION_REACTION',
      opaqueRefs: ['navigation:n1'],
      evidence: ['UNEXPECTED_NAV_TARGET', 'oauth-like'],
    }).ok).toBe(false);
  });

  it('applies policy risk and rollback ceilings', () => {
    const validator = new AutonomyPolicyValidator();
    expect(validator.approve({
      primitiveId: 'RESTORE_SCROLL',
      mechanism: 'UNKNOWN_PLAYER_REACTION',
      opaqueRefs: [],
      evidence: ['SCROLL_LOCK_ON', 'INTERACTION_DENIED'],
    }, { maxRisk: 0.1, maxPrivacy: 0.1, requiredRollbackConfidence: 0.95, rollbackConfidence: 0.99 }).ok).toBe(true);
    expect(validator.approve({
      primitiveId: 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET',
      mechanism: 'UNKNOWN_NAVIGATION_REACTION',
      opaqueRefs: ['navigation:n1'],
      evidence: ['UNEXPECTED_NAV_TARGET'],
    }, { maxRisk: 0.1, maxPrivacy: 0.1, requiredRollbackConfidence: 0.95, rollbackConfidence: 0.99 }).ok).toBe(false);
  });
});
