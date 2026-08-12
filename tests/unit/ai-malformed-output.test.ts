import { describe, it, expect } from 'vitest';
import { PolicyValidator } from '../../src/shared/ai/validator';
import { EvidencePacket } from '../../src/shared/ai/types';

describe('Phase 2.5 Malformed Model Output & Fail-Closed Suite', () => {
  const validator = new PolicyValidator();

  const validEvidence: EvidencePacket = {
    schemaVersion: 1,
    transactionId: 'tx_malformed_test',
    navigationEpoch: 'nav_malformed_test',
    timestamp: Date.now(),
    siteContext: { originClass: 'news', pageTypeEstimate: 'article' },
    trigger: { reason: 'FULLSCREEN_GATE', confidence: 0.9 },
    healthBefore: {
      antiBlockReaction: 0.8,
      contentAvailability: 0.3,
      interaction: 0.2,
      scrollability: 0.0,
      navigationHealth: 1.0,
      visualObstruction: 0.8,
      mutationStability: 1.0,
      confidence: 0.9,
    },
    currentHealth: {
      antiBlockReaction: 0.8,
      contentAvailability: 0.3,
      interaction: 0.2,
      scrollability: 0.0,
      navigationHealth: 1.0,
      visualObstruction: 0.8,
      mutationStability: 1.0,
      confidence: 0.9,
    },
    observedReaction: {
      detectorTypes: ['FULLSCREEN_GATE'],
      antiBlockConfidence: 0.9,
      mutationBurstDetected: false,
    },
    candidateElements: [
      {
        ref: 'element:e1',
        role: 'fullscreen-overlay',
        viewportCoverage: 0.9,
        isFixedOrAbsolute: true,
        hasHighZIndex: true,
        textSignals: ['adblock detected'],
        interactionSuppressed: true,
      },
    ],
    candidateRequests: [],
    availableActions: ['DOM_REMOVE_OVERLAY', 'DOM_RESTORE_SCROLL', 'ABSTAIN'],
    knownConstraints: ['NO_ARBITRARY_JS'],
    previousAttempts: [],
  };

  it('Rejects null, undefined, primitive, and non-object inputs', () => {
    expect(validator.validate(validEvidence, null).valid).toBe(false);
    expect(validator.validate(validEvidence, undefined).valid).toBe(false);
    expect(validator.validate(validEvidence, '{"decision":"ADAPT"}').valid).toBe(false);
    expect(validator.validate(validEvidence, 12345).valid).toBe(false);
    expect(validator.validate(validEvidence, true).valid).toBe(false);
  });

  it('Rejects unsupported schema versions', () => {
    const plan = {
      schemaVersion: 2,
      decision: 'ADAPT',
      hypothesis: { category: 'FULLSCREEN_GATE', confidence: 0.9, explanation: 'Test' },
      selectedStrategyTier: 'S3',
      actions: [{ actionType: 'DOM_REMOVE_OVERLAY', targetRef: 'element:e1', parameter: '' }],
      verification: { expectedHealthDelta: 0.3, maxWaitMs: 1500 },
      abortConditions: [],
      explanationCodes: [],
    };
    const result = validator.validate(validEvidence, plan);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('Unsupported schemaVersion'))).toBe(true);
  });

  it('Rejects invalid decision enums', () => {
    const plan = {
      schemaVersion: 1,
      decision: 'NUKE_WEBSITE',
      hypothesis: { category: 'FULLSCREEN_GATE', confidence: 0.9, explanation: 'Test' },
      selectedStrategyTier: 'S3',
      actions: [],
      verification: { expectedHealthDelta: 0.3, maxWaitMs: 1500 },
      abortConditions: [],
      explanationCodes: [],
    };
    const result = validator.validate(validEvidence, plan);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('Invalid decision'))).toBe(true);
  });

  it('Rejects confidence values outside [0, 1] including NaN, Infinity, and negatives', () => {
    const invalidConfidences = [-0.1, 1.05, 999, NaN, Infinity, -Infinity];
    for (const conf of invalidConfidences) {
      const plan = {
        schemaVersion: 1,
        decision: 'ADAPT',
        hypothesis: { category: 'FULLSCREEN_GATE', confidence: conf, explanation: 'Test' },
        selectedStrategyTier: 'S3',
        actions: [{ actionType: 'DOM_REMOVE_OVERLAY', targetRef: 'element:e1', parameter: '' }],
        verification: { expectedHealthDelta: 0.3, maxWaitMs: 1500 },
        abortConditions: [],
        explanationCodes: [],
      };
      const result = validator.validate(validEvidence, plan);
      expect(result.valid).toBe(false);
    }
  });

  it('Rejects references to non-existent elements and requests (Opaque Reference Integrity)', () => {
    const badRefPlan = {
      schemaVersion: 1,
      decision: 'ADAPT',
      hypothesis: { category: 'FULLSCREEN_GATE', confidence: 0.9, explanation: 'Test' },
      selectedStrategyTier: 'S3',
      actions: [{ actionType: 'DOM_REMOVE_OVERLAY', targetRef: 'element:e9999', parameter: '' }],
      verification: { expectedHealthDelta: 0.3, maxWaitMs: 1500 },
      abortConditions: [],
      explanationCodes: [],
    };
    const result = validator.validate(validEvidence, badRefPlan);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('non-existent element'))).toBe(true);
  });

  it('Rejects illegal actions not present in EvidencePacket availableActions', () => {
    const illegalActionPlan = {
      schemaVersion: 1,
      decision: 'ADAPT',
      hypothesis: { category: 'FULLSCREEN_GATE', confidence: 0.9, explanation: 'Test' },
      selectedStrategyTier: 'S3',
      actions: [{ actionType: 'NET_TEMP_BLOCK', targetRef: '', parameter: '||evil.com^' }],
      verification: { expectedHealthDelta: 0.3, maxWaitMs: 1500 },
      abortConditions: [],
      explanationCodes: [],
    };
    const result = validator.validate(validEvidence, illegalActionPlan);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('not in availableActions'))).toBe(true);
  });

  it('Rejects out-of-bounds verification maxWaitMs (<0 or >10000ms)', () => {
    const badWaitTimes = [-100, 15000, 999999];
    for (const wait of badWaitTimes) {
      const plan = {
        schemaVersion: 1,
        decision: 'ADAPT',
        hypothesis: { category: 'FULLSCREEN_GATE', confidence: 0.9, explanation: 'Test' },
        selectedStrategyTier: 'S3',
        actions: [{ actionType: 'DOM_REMOVE_OVERLAY', targetRef: 'element:e1', parameter: '' }],
        verification: { expectedHealthDelta: 0.3, maxWaitMs: wait },
        abortConditions: [],
        explanationCodes: [],
      };
      const result = validator.validate(validEvidence, plan);
      expect(result.valid).toBe(false);
      expect(result.reasons.some((r) => r.includes('maxWaitMs'))).toBe(true);
    }
  });
});
