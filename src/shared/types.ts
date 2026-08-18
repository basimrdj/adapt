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
  | 'DOM_RESTORE_PLAYER'
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
  /** Empty when requestDomains carries the match (host-wide learned rules). */
  urlFilter: string;
  resourceTypes?: chrome.declarativeNetRequest.ResourceType[];
  isRegex?: boolean;
  /** DNR-native host matching (Chrome 101+); preferred over fragile URL strings. */
  requestDomains?: string[];
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
    | 'DOM_RESTORE_PLAYER'
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
  /** Coarse semantic categories; raw page text is never emitted. */
  categories?: Array<
    | 'ANTI_BLOCK_INSTRUCTION'
    | 'AD_REVENUE_APPEAL'
    | 'PLAYBACK_GATE'
    | 'INTERACTION_DENIAL'
    | 'BENIGN_CONSENT'
    | 'BENIGN_NEWSLETTER'
    | 'BENIGN_LOGIN'
    | 'BENIGN_PAYWALL'
    | 'UNKNOWN_SEMANTIC_REACTION'
  >;
  featureHash?: string;
  adblockKeywordDensity: number;
  confidenceScore: number;
}

export type InteractionType = 'click' | 'pointerup' | 'keyboard-activate';
export type ElementSemanticRole = 'link' | 'button' | 'media-control' | 'unknown';
export type DestinationClass =
  | 'same-origin'
  | 'cross-origin'
  | 'download'
  | 'oauth-like'
  | 'payment-like'
  | 'document'
  | 'unknown';

export interface UserIntentEnvelope {
  ref: `intent:i${number}`;
  documentMonotonicMs: number;
  capturedWallMs: number;
  elementRef: `element:e${number}`;
  elementRole: ElementSemanticRole;
  declaredDestinationClass: DestinationClass;
  declaredDestinationFingerprint?: string;
  button: number;
  modifiers: string[];
  interactionType: InteractionType;
  navigationReasonablyExpected: boolean;
  sourceOriginHash: string;
  eventTrusted?: boolean;
  targetBehavior?: 'same-context' | 'new-context' | 'download' | 'unknown';
  newContextReasonablyExpected?: boolean;
  downloadLikeIntent?: boolean;
}

export interface NavigationTargetObservation {
  ref: `navigation:n${number}`;
  sourceTabId: number;
  sourceFrameId: number;
  sourceDocumentId?: string;
  targetTabId: number;
  capturedWallMs: number;
  sourceOriginHash: string;
  destinationOriginHash: string;
  destinationFingerprint?: string;
  destinationClass: DestinationClass;
  redirectCount: number;
  foregroundState: 'foreground' | 'background' | 'unknown';
  openerRelationship: 'explicit' | 'implicit' | 'unknown';
  recentIntentRef?: `intent:i${number}`;
  recentIntentAgeMs?: number;
  riskSignals: string[];
  declaredDestinationClass?: DestinationClass;
  navigationReasonablyExpected?: boolean;
  targetCreationSequence?: number;
  destinationMatch?: boolean;
  destinationFingerprintMatch?: 'MATCH' | 'MISMATCH' | 'UNKNOWN';
  expectedNewContextCount?: number;
  observedNewContextCount?: number;
  intendedNavigationSucceeded?: boolean;
  extraTarget?: boolean;
  expectedNewContext?: boolean;
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
  anomalyCategories?: string[];
}

export interface OpaqueElementObservation {
  ref: `element:e${number}`;
  role: 'fullscreen-overlay' | 'semantic-reaction-ui' | 'bait-candidate';
  viewportCoverage: number;
  visible: boolean;
  resourceIdentityHash?: string;
  resourceType?: string;
  thirdPartyResource?: boolean;
}

export type SurvivorClass =
  | 'VISIBLE_AD_SURFACE'
  | 'THIRD_PARTY_AD_FRAME'
  | 'PROMOTIONAL_SURFACE'
  | 'ANTI_BLOCK_REACTION'
  | 'UNWANTED_NAVIGATION'
  | 'POPUP_ATTEMPT'
  | 'SUSPICIOUS_REDIRECT'
  | 'TRACKING_BEACON_CANDIDATE'
  | 'SUSPICIOUS_UNBLOCKED_NETWORK_RESOURCE'
  | 'REINSERTED_SURFACE'
  | 'PLAYER_OBSTRUCTION';

export interface OpaqueSurvivorObservation {
  ref: `survivor:s${number}`;
  class: SurvivorClass;
  documentScope: string;
  observedAt: number;
  confidence: number;
  evidenceClasses: string[];
  elementRef?: `element:e${number}`;
  resourceIdentityHash?: string;
  resourceType?: string;
  protectedContext: {
    authOrPayment: boolean;
    media: boolean;
    downloadOrDocument: boolean;
    userIntentRelated: boolean;
  };
  features: {
    visible: boolean;
    thirdPartyResource: boolean;
    fixedOrAbsolute: boolean;
    isolatedSurface: boolean;
    semanticAdLabel: boolean;
    recentInsertion: boolean;
    mutationAssociation: number;
    viewportCoverage: number;
  };
}

export interface ResourceAssociationObservation {
  elementRef: `element:e${number}`;
  resourceIdentityHash: string;
  resourceType: string;
  thirdPartyResource: boolean;
  visible: boolean;
}

export interface CausalPageObservationBatch {
  timestamp: number;
  pageSignals: PageSignalBatch;
  elements: OpaqueElementObservation[];
  survivors?: OpaqueSurvivorObservation[];
  resourceAssociations?: ResourceAssociationObservation[];
  intents?: UserIntentEnvelope[];
}

export interface AuditEvent {
  id: string;
  timestamp: number;
  siteKey: string;
  tabId: number;
  eventType: 'DETECTION' | 'EXPERIMENT_STAGED' | 'VERIFICATION_SUCCESS' | 'VERIFICATION_FAILURE' | 'ROLLBACK' | 'RECIPE_PROMOTED' | 'RECIPE_DEGRADED';
  details: Record<string, unknown>;
}
