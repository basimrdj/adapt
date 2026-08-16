import { HealthVector, StrategyAction } from '../types';

export type PlanDecision = 'ADAPT' | 'OBSERVE' | 'ABSTAIN';

export type AllowedAiActionType =
  | 'DOM_REMOVE_OVERLAY'
  | 'DOM_RESTORE_SCROLL'
  | 'DOM_RESTORE_POINTER_EVENTS'
  | 'DOM_PRESERVE_BAIT'
  | 'DOM_HIDE_CANDIDATE'
  | 'NET_TEMP_BLOCK'
  | 'TARGETED_SESSION_DNR'
  | 'NET_REDIRECT_LOCAL'
  | 'OBSERVE_MORE'
  | 'ABSTAIN';

export interface OpaqueCandidateElement {
  ref: string; // e.g. "element:e1"
  role: string; // e.g. "fullscreen-overlay", "dialog", "backdrop"
  viewportCoverage: number; // 0.0 - 1.0
  isFixedOrAbsolute: boolean;
  hasHighZIndex: boolean;
  textSignals: string[]; // Sanitized keywords only
  interactionSuppressed: boolean;
}

export interface OpaqueCandidateRequest {
  ref: string; // e.g. "request:r1"
  urlDomain: string; // e.g. "ad-delivery.net"
  resourceType: string; // "script", "xmlhttprequest", "image"
  isBlockedByBaseline: boolean;
  failureObserved: boolean;
  thirdParty?: boolean;
  resourceIdentityHash?: string;
  lagToSurvivorMs?: number;
  frameAssociation?: string;
  mutationAssociation?: number;
  repeatCount?: number;
  filterEvidence?: string;
}

export interface EvidencePacket {
  schemaVersion: number;
  transactionId: string;
  navigationEpoch: string;
  timestamp: number;

  siteContext: {
    originClass: string; // e.g. "content-publisher", "single-page-app"
    pageTypeEstimate: string;
  };

  trigger: {
    reason: string;
    confidence: number;
  };

  healthBefore: HealthVector;
  currentHealth: HealthVector;

  observedReaction: {
    detectorTypes: string[];
    antiBlockConfidence: number;
    mutationBurstDetected: boolean;
  };

  candidateElements: OpaqueCandidateElement[];
  candidateRequests: OpaqueCandidateRequest[];

  availableActions: AllowedAiActionType[];
  knownConstraints: string[];
  previousAttempts: Array<{
    attemptNumber: number;
    actionType: string;
    outcomeHealthDelta: number;
  }>;
}

export interface PlannedActionProposal {
  actionType: AllowedAiActionType;
  targetRef?: string; // Must match an opaque ref from EvidencePacket
  parameter?: string; // Must be pre-approved or empty
}

export interface AdaptationPlan {
  schemaVersion: number;
  decision: PlanDecision;
  hypothesis: {
    category: string;
    confidence: number;
    explanation: string;
  };
  selectedStrategyTier: 'S1' | 'S2' | 'S3' | 'ABSTAIN';
  actions: PlannedActionProposal[];
  verification: {
    expectedHealthDelta: number;
    maxWaitMs: number;
  };
  abortConditions: string[];
  explanationCodes: string[];
}

export interface PolicyValidationResult {
  valid: boolean;
  reasons: string[];
  sanitizedPlan?: AdaptationPlan;
  mappedStrategyActions?: StrategyAction[];
}
