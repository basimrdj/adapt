import { PageSignalBatch, HealthVector } from '../types';
import { EvidencePacket, OpaqueCandidateElement, OpaqueCandidateRequest } from './types';

export function createEvidencePacket(
  _tabId: number,
  navigationId: string,
  _siteKey: string,
  batch: PageSignalBatch,
  health: HealthVector
): EvidencePacket {
  const candidateElements: OpaqueCandidateElement[] = [];
  const candidateRequests: OpaqueCandidateRequest[] = [];

  // Construct opaque elements from geometry & semantic signals
  if (batch.geometry.hasFixedOverlay) {
    candidateElements.push({
      ref: 'element:e1',
      role: 'fullscreen-overlay',
      viewportCoverage: batch.geometry.overlayCoverageRatio,
      isFixedOrAbsolute: true,
      hasHighZIndex: true,
      textSignals: batch.semantic.detectedPhrases.slice(0, 5),
      interactionSuppressed: batch.interaction.pointerEventsSuppressed,
    });
  }

  return {
    schemaVersion: 1,
    transactionId: `tx_ai_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    navigationEpoch: navigationId,
    timestamp: Date.now(),
    siteContext: {
      originClass: 'publisher',
      pageTypeEstimate: 'article',
    },
    trigger: {
      reason: batch.suspectedDetectorTypes[0] || 'REACTION_OBSERVED',
      confidence: health.antiBlockReaction,
    },
    healthBefore: health,
    currentHealth: health,
    observedReaction: {
      detectorTypes: batch.suspectedDetectorTypes,
      antiBlockConfidence: health.antiBlockReaction,
      mutationBurstDetected: batch.mutation.mutationRatePerSecond > 100,
    },
    candidateElements,
    candidateRequests,
    availableActions: [
      'DOM_REMOVE_OVERLAY',
      'DOM_RESTORE_SCROLL',
      'DOM_RESTORE_POINTER_EVENTS',
      'DOM_PRESERVE_BAIT',
      'ABSTAIN',
    ],
    knownConstraints: ['NO_ARBITRARY_JS', 'STRICT_OPAQUE_REFS_ONLY'],
    previousAttempts: [],
  };
}
