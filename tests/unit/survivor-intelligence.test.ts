import { describe, expect, it } from 'vitest';
import { resourceIdentity } from '../../src/shared/resource-identity';
import { generateHypothesisLattice } from '../../src/background/autonomy/hypothesis-lattice';
import { PolicyValidator } from '../../src/shared/ai/validator';
import { EvidencePacket } from '../../src/shared/ai/types';
import { HealthVector } from '../../src/shared/types';
import { EventNode } from '../../src/shared/causal/events';

const health: HealthVector = {
  antiBlockReaction: 0.4,
  contentAvailability: 1,
  interaction: 1,
  scrollability: 1,
  navigationHealth: 1,
  visualObstruction: 0,
  mutationStability: 1,
  networkIntegrity: 1,
  privacyPreservation: 1,
  confidence: 1,
};

const packet: EvidencePacket = {
  schemaVersion: 1,
  transactionId: 'test',
  navigationEpoch: 'nav',
  timestamp: Date.now(),
  siteContext: { originClass: 'publisher', pageTypeEstimate: 'unknown' },
  trigger: { reason: 'SURVIVOR_ATTRIBUTION', confidence: 0.8 },
  healthBefore: health,
  currentHealth: health,
  observedReaction: { detectorTypes: [], antiBlockConfidence: 0.4, mutationBurstDetected: false },
  candidateElements: [{
    ref: 'element:e1',
    role: 'VISIBLE_AD_SURFACE',
    viewportCoverage: 0.3,
    isFixedOrAbsolute: true,
    hasHighZIndex: true,
    textSignals: ['visible', 'third-party-or-isolated'],
    interactionSuppressed: false,
  }],
  candidateRequests: [{
    ref: 'request:r1',
    urlDomain: 'redacted',
    resourceType: 'script',
    isBlockedByBaseline: false,
    failureObserved: false,
    thirdParty: true,
  }],
  availableActions: ['TARGETED_SESSION_DNR', 'DOM_REMOVE_OVERLAY', 'ABSTAIN'],
  knownConstraints: ['OPAQUE_REFS_ONLY'],
  previousAttempts: [],
};

describe('survivor intelligence primitives', () => {
  it('hashes resource identity without query or fragment', () => {
    const first = resourceIdentity('https://cdn.example.test/ad.js?session=one#x', 'https://site.example.test');
    const second = resourceIdentity('https://cdn.example.test/ad.js?session=two#y', 'https://site.example.test');
    expect(first?.hash).toBe(second?.hash);
    expect(first?.pathname).toBe('/ad.js');
  });

  it('creates a network hypothesis from a successful request and visible survivor', () => {
    const nodes: EventNode[] = [
      {
        id: 'event:request' as const,
        kind: 'REQUEST_COMPLETE' as const,
        scope: { tabId: 1, navigationEpoch: 1, documentId: 'doc', frameId: 0, originHash: 'origin' },
        timestamp: { value: 100, domain: 'extension.wall_ms' as const },
        refs: ['request:r1' as const],
        features: { resourceType: 'script', thirdParty: true },
        provenance: 'webRequest' as const,
        observationConfidence: 1,
      },
      {
        id: 'event:survivor' as const,
        kind: 'VISIBLE_AD_CANDIDATE' as const,
        scope: { tabId: 1, navigationEpoch: 1, documentId: 'doc', frameId: 0, originHash: 'origin' },
        timestamp: { value: 200, domain: 'extension.wall_ms' as const },
        refs: ['survivor:s1' as const, 'element:e1' as const],
        features: { thirdPartyResource: true },
        provenance: 'mutationObserver' as const,
        observationConfidence: 0.9,
      },
    ];
    const hypotheses = generateHypothesisLattice(nodes);
    expect(hypotheses.some((item) => item.mechanismClass === 'UNKNOWN_NETWORK_REACTION')).toBe(true);
  });

  it('accepts only supplied request refs for targeted session DNR', () => {
    const validator = new PolicyValidator();
    const valid = validator.validate(packet, {
      schemaVersion: 1,
      decision: 'ADAPT',
      hypothesis: { category: 'UNKNOWN', confidence: 0.8, explanation: 'supplied candidate only' },
      selectedStrategyTier: 'S2',
      actions: [{ actionType: 'TARGETED_SESSION_DNR', targetRef: 'request:r1', parameter: '' }],
      verification: { expectedHealthDelta: 0.1, maxWaitMs: 500 },
      abortConditions: [],
      explanationCodes: [],
    });
    expect(valid.valid).toBe(true);

    const fabricated = validator.validate(packet, {
      schemaVersion: 1,
      decision: 'ADAPT',
      hypothesis: { category: 'UNKNOWN', confidence: 0.8, explanation: 'fabricated ref' },
      selectedStrategyTier: 'S2',
      actions: [{ actionType: 'TARGETED_SESSION_DNR', targetRef: 'request:r999', parameter: '' }],
      verification: { expectedHealthDelta: 0.1, maxWaitMs: 500 },
      abortConditions: [],
      explanationCodes: [],
    });
    expect(fabricated.valid).toBe(false);
  });
});
