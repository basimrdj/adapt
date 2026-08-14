/**
 * Core type definitions for ADAPT Manifest V3 content blocker and adaptive transaction engine.
 */

export interface HealthVector {
  antiBlockReaction: number; // 0..1 (LOWER is better)
  contentAvailability: number; // 0..1 (HIGHER is better)
  interaction: number; // 0..1 (HIGHER is better)
  scrollability: number; // 0..1 (HIGHER is better)
  navigationHealth: number; // 0..1 (HIGHER is better)
  visualObstruction: number; // 0..1 (LOWER is better)
  mutationStability: number; // 0..1 (HIGHER is better)
  mediaHealth?: number; // 0..1 (HIGHER is better)
  /** Background-derived request success ratio; absent when network telemetry is unavailable. */
  networkIntegrity?: number;
  /** Background-derived score accounting for temporary allow rules and tracker risk. */
  privacyPreservation?: number;
  confidence: number; // 0..1
}

export type ActionType =
  | 'NET_BLOCK'
  | 'NET_ALLOW_EXCEPTION'
  | 'NET_REDIRECT_LOCAL'
  | 'NET_DISABLE_SITE_RULE'
  | 'DOM_HIDE'
  | 'DOM_COLLAPSE'
  | 'DOM_RESTORE'
  | 'DOM_REMOVE_OVERLAY'
  | 'DOM_RESTORE_SCROLL'
  | 'DOM_RESTORE_POINTER_EVENTS'
  | 'DOM_PRESERVE_BAIT_CANDIDATE'
  | 'BAIT_PRESERVE_LAYOUT'
  | 'BAIT_RESTORE_VISIBILITY'
  | 'BAIT_DISABLE_COSMETIC_HIDE'
  | 'BAIT_PRESERVE_CHILD_STRUCTURE'
  | 'RUNTIME_OP'
  | 'OBSERVE'
  | 'WAIT_STABILITY'
  | 'ROLLBACK'
  | 'COMMIT_RECIPE';

export interface BaseAction {
  id: string;
  type: ActionType;
  description?: string;
}

export interface NetBlockAction extends BaseAction {
  type: 'NET_BLOCK';
  urlFilter: string;
  resourceTypes?: chrome.declarativeNetRequest.ResourceType[];
  isRegex?: boolean;
}

export interface NetAllowAction extends BaseAction {
  type: 'NET_ALLOW_EXCEPTION';
  urlFilter: string;
  resourceTypes?: chrome.declarativeNetRequest.ResourceType[];
}

export interface NetRedirectAction extends BaseAction {
  type: 'NET_REDIRECT_LOCAL';
  urlFilter: string;
  extensionPath: string;
}

export interface DomAction extends BaseAction {
  type:
    | 'DOM_HIDE'
    | 'DOM_COLLAPSE'
    | 'DOM_RESTORE'
    | 'DOM_REMOVE_OVERLAY'
    | 'DOM_RESTORE_SCROLL'
    | 'DOM_RESTORE_POINTER_EVENTS'
    | 'DOM_PRESERVE_BAIT_CANDIDATE'
    | 'BAIT_PRESERVE_LAYOUT'
    | 'BAIT_RESTORE_VISIBILITY'
    | 'BAIT_DISABLE_COSMETIC_HIDE'
    | 'BAIT_PRESERVE_CHILD_STRUCTURE';
  selector?: string;
  /** Content-script-owned opaque element reference. AI never sees or creates selectors. */
  targetRef?: `element:e${number}`;
  styleId?: string;
  cssText?: string;
  targetProperty?: string;
  fallbackValue?: string;
}

export interface RuntimeOpAction extends BaseAction {
  type: 'RUNTIME_OP';
  opId: string;
  params?: Record<string, string | number | boolean>;
}

export type StrategyAction = NetBlockAction | NetAllowAction | NetRedirectAction | DomAction | RuntimeOpAction;

export type StrategyLadderTier = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7';

export interface StrategyCandidate {
  id: string;
  tier: StrategyLadderTier;
  name: string;
  rationale: string;
  actions: StrategyAction[];
  isReversible: boolean;
  estimatedRisk: 'LOW' | 'MEDIUM' | 'HIGH';
}

export type TransactionState =
  | 'candidate'
  | 'staged'
  | 'observing'
  | 'committing'
  | 'committed'
  | 'rolling_back'
  | 'rolled_back'
  | 'failed';

export interface VerificationResult {
  success: boolean;
  scoreDelta: number;
  reactionDelta: number;
  contentDelta: number;
  interactionDelta: number;
  notes: string;
  postHealth: HealthVector;
}

export interface AdaptationTransaction {
  txId: string;
  tabId: number;
  navigationId: string;
  documentId?: string;
  siteKey: string;
  createdAt: number;
  updatedAt: number;
  baselineHealth: HealthVector;
  candidate: StrategyCandidate;
  sessionRuleIds: number[];
  domActionIds: string[];
  state: TransactionState;
  verification?: VerificationResult;
}

export type RecipeState = 'candidate' | 'provisional' | 'confirmed' | 'degraded' | 'quarantined' | 'expired';

export interface RecipeEvidence {
  successfulNavigations: number;
  lastHealthDelta: number;
  confidence: number;
  observedDetectorTypes: string[];
}

export interface SiteRecipe {
  schemaVersion: number;
  siteKey: string;
  match: {
    host: string;
    pathClass?: string;
  };
  actions: StrategyAction[];
  evidence: RecipeEvidence;
  state: RecipeState;
  createdAt: number;
  updatedAt: number;
}

export interface NavigationEpoch {
  tabId: number;
  navigationId: string;
  /** Chrome webNavigation documentId. Synthetic `missing:` prefix if Chrome did not supply one. */
  documentId: string;
  /** ADAPT-assigned monotonic per-tab counter. Starts at 1. Increments on real nav and SPA history. */
  navigationEpoch: number;
  frameId: number;
  parentFrameId?: number;
  url: string;
  origin: string;
  siteKey: string;
  startTime: number;
  isMainFrame: boolean;
}

export interface GeometrySignal {
  viewportWidth: number;
  viewportHeight: number;
  hasFixedOverlay: boolean;
  overlayCoverageRatio: number;
  bodyScrollLocked: boolean;
  htmlScrollLocked: boolean;
  modalCount: number;
  mainContentHidden: boolean;
  mainContentHeight: number;
}

export interface SemanticSignal {
  detectedPhrases: string[];
  adblockKeywordDensity: number;
  confidenceScore: number;
}

export interface InteractionSignal {
  pointerEventsSuppressed: boolean;
  bodyOverflowHidden: boolean;
  contentCovered: boolean;
}

export interface MutationSignal {
  mutationRatePerSecond: number;
  rapidReinsertionDetected: boolean;
  overlayReinsertedCount: number;
  degradationState: 'NORMAL' | 'COALESCED' | 'SAMPLING' | 'PAUSED';
}

export interface PageSignalBatch {
  navigationId: string;
  timestamp: number;
  geometry: GeometrySignal;
  semantic: SemanticSignal;
  interaction: InteractionSignal;
  mutation: MutationSignal;
  suspectedDetectorTypes: string[];
}

export interface OpaqueElementObservation {
  ref: `element:e${number}`;
  role: 'fullscreen-overlay' | 'bait-candidate';
  viewportCoverage: number;
  visible: boolean;
}

export interface CausalPageObservationBatch {
  timestamp: number;
  pageSignals: PageSignalBatch;
  elements: OpaqueElementObservation[];
}

export interface AuditEvent {
  id: string;
  timestamp: number;
  siteKey: string;
  tabId: number;
  eventType: 'DETECTION' | 'EXPERIMENT_STAGED' | 'VERIFICATION_SUCCESS' | 'VERIFICATION_FAILURE' | 'ROLLBACK' | 'RECIPE_PROMOTED' | 'RECIPE_DEGRADED';
  details: Record<string, unknown>;
}
