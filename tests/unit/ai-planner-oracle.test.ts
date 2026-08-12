import { describe, it, expect } from 'vitest';
import { MockPlanner } from '../../src/shared/ai/mock-planner';
import { PolicyValidator } from '../../src/shared/ai/validator';
import { EvidencePacket, AdaptationPlan } from '../../src/shared/ai/types';
import { startOracleServer } from '../../tools/ai-oracle/server';
import http from 'http';

describe('Phase 2 AI Planner & Oracle Security Suite', () => {
  const dummyEvidence: EvidencePacket = {
    schemaVersion: 1,
    transactionId: 'tx_123',
    navigationEpoch: 'nav_123',
    timestamp: Date.now(),
    siteContext: { originClass: 'news', pageTypeEstimate: 'article' },
    trigger: { reason: 'FULLSCREEN_GATE_DETECTED', confidence: 0.9 },
    healthBefore: {
      antiBlockReaction: 0.8,
      contentAvailability: 0.4,
      interaction: 0.3,
      scrollability: 0.0,
      navigationHealth: 1.0,
      visualObstruction: 0.8,
      mutationStability: 1.0,
      confidence: 0.9,
    },
    currentHealth: {
      antiBlockReaction: 0.8,
      contentAvailability: 0.4,
      interaction: 0.3,
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
        textSignals: ['disable your ad blocker'],
        interactionSuppressed: true,
      },
    ],
    candidateRequests: [],
    availableActions: ['DOM_REMOVE_OVERLAY', 'DOM_RESTORE_SCROLL', 'DOM_RESTORE_POINTER_EVENTS'],
    knownConstraints: [],
    previousAttempts: [],
  };

  it('MockPlanner generates valid structured adaptation plan for fullscreen overlay', async () => {
    const planner = new MockPlanner();
    const plan = await planner.plan(dummyEvidence);

    expect(plan.decision).toBe('ADAPT');
    expect(plan.selectedStrategyTier).toBe('S3');
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions[0].targetRef).toBe('element:e1');

    const validator = new PolicyValidator();
    const result = validator.validate(dummyEvidence, plan);
    expect(result.valid).toBe(true);
    expect(result.mappedStrategyActions).toHaveLength(3);
  });

  it('PolicyValidator rejects plan referencing non-existent opaque element', () => {
    const validator = new PolicyValidator();
    const illegalPlan: AdaptationPlan = {
      schemaVersion: 1,
      decision: 'ADAPT',
      hypothesis: { category: 'FULLSCREEN_GATE', confidence: 0.9, explanation: 'Test' },
      selectedStrategyTier: 'S3',
      actions: [{ actionType: 'DOM_REMOVE_OVERLAY', targetRef: 'element:e999', parameter: '' }],
      verification: { expectedHealthDelta: 0.3, maxWaitMs: 1000 },
      abortConditions: [],
      explanationCodes: [],
    };

    const result = validator.validate(dummyEvidence, illegalPlan);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('non-existent element'))).toBe(true);
  });

  it('PolicyValidator rejects plan with illegal action not in availableActions', () => {
    const validator = new PolicyValidator();
    const illegalPlan: AdaptationPlan = {
      schemaVersion: 1,
      decision: 'ADAPT',
      hypothesis: { category: 'FULLSCREEN_GATE', confidence: 0.9, explanation: 'Test' },
      selectedStrategyTier: 'S3',
      actions: [{ actionType: 'NET_TEMP_BLOCK', targetRef: '', parameter: '||evil.com^' }],
      verification: { expectedHealthDelta: 0.3, maxWaitMs: 1000 },
      abortConditions: [],
      explanationCodes: [],
    };

    const result = validator.validate(dummyEvidence, illegalPlan);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('not in availableActions'))).toBe(true);
  });

  it('Oracle Server strictly enforces auth token, payload size limits, and localhost binding', async () => {
    const planner = new MockPlanner();
    const oracle = await startOracleServer(planner, { port: 4055, maxPayloadBytes: 2000 });

    try {
      // 1. Request without Auth -> 401
      const res401 = await new Promise<{ statusCode?: number }>((resolve) => {
        const req = http.request(
          'http://127.0.0.1:4055/plan',
          { method: 'POST' },
          (res) => resolve({ statusCode: res.statusCode })
        );
        req.end(JSON.stringify({ test: 1 }));
      });
      expect(res401.statusCode).toBe(401);

      // 2. Request with Valid Auth -> 200
      const res200 = await new Promise<{ statusCode?: number; body: string }>((resolve) => {
        const req = http.request(
          'http://127.0.0.1:4055/plan',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${oracle.config.sessionToken}`,
              'Content-Type': 'application/json',
            },
          },
          (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
          }
        );
        req.end(JSON.stringify(dummyEvidence));
      });
      expect(res200.statusCode).toBe(200);
      const parsed = JSON.parse(res200.body);
      expect(parsed.plan.decision).toBe('ADAPT');
      expect(parsed.validation.valid).toBe(true);

      // 3. Oversized payload -> 413
      const largePayload = JSON.stringify({ ...dummyEvidence, padding: 'x'.repeat(4000) });
      const res413 = await new Promise<{ statusCode?: number }>((resolve) => {
        const req = http.request(
          'http://127.0.0.1:4055/plan',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${oracle.config.sessionToken}`,
              'Content-Type': 'application/json',
            },
          },
          (res) => resolve({ statusCode: res.statusCode })
        );
        req.end(largePayload);
      });
      expect(res413.statusCode).toBe(413);
    } finally {
      await oracle.close();
    }
  });
});
