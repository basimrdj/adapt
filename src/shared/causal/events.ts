/**
 * Phase 3 M1 — event identity, clock domains, and normalized EventNode types.
 *
 * Invariants:
 * - Causal identity is { tabId, navigationEpoch, documentId, frameId }. Never processId.
 * - EventNode.scope.originHash is SHA-256 hex of the origin, never a raw origin/url/query.
 * - features must not contain raw page text, CSS selectors, form values, cookies,
 *   auth headers, or cross-origin global identifiers.
 * - Never subtract timestamps across ClockDomains (see timestampDeltaMs).
 */

export type ClockDomain =
  | 'extension.wall_ms'
  | 'extension.monotonic_ms'
  | 'document.performance_ms'
  | 'cdp.monotonic_s'
  | 'network.server_date_ms';

export interface Timestamp {
  value: number;
  domain: ClockDomain;
  capturedWallMs?: number;
}

export type CausalDocumentKey = {
  tabId: number;
  navigationEpoch: number;
  documentId: string;
  frameId: number;
};

export type OpaqueRef =
  | `event:${string}`
  | `element:e${number}`
  | `request:r${number}`
  | `resource:res${number}`
  | `frame:f${number}`
  | `intent:i${number}`
  | `navigation:n${number}`
  | `primitive:p${number}`
  | `strategy:s${number}`
  | `hypothesis:h${number}`
  | `experiment:x${number}`
  | `recipe:rcp${number}`;

export type EventKind =
  | 'NAV_START'
  | 'NAV_COMMIT'
  | 'DOM_READY'
  | 'LOAD'
  | 'REQUEST_START'
  | 'REQUEST_COMPLETE'
  | 'REQUEST_ERROR'
  | 'RESOURCE_TIMING'
  | 'MUTATION_BURST'
  | 'OVERLAY_APPEARED'
  | 'OVERLAY_REMOVED'
  | 'SCROLL_LOCK_ON'
  | 'SCROLL_LOCK_OFF'
  | 'CONTENT_VISIBILITY_CHANGED'
  | 'CONTENT_HEIGHT_CHANGED'
  | 'BAIT_STATE_CHANGED'
  | 'USER_INTENT'
  | 'ANTI_BLOCK_REACTION'
  | 'SEMANTIC_GATE'
  | 'INTERACTION_DENIED'
  | 'PLAYBACK_OBSTRUCTED'
  | 'VISIBLE_AD_CANDIDATE'
  | 'UNEXPECTED_NAV_TARGET'
  | 'POPUP_OR_POPUNDER'
  | 'SUSPICIOUS_REDIRECT_CHAIN'
  | 'WINDOW_OPEN_REACTION'
  | 'NAVIGATION_BOUNCE'
  | 'NETWORK_PROBE_REACTION'
  | 'REPEATED_REINSERTION'
  | 'UNKNOWN_REACTION'
  | 'HEALTH_SNAPSHOT'
  | 'EXPERIMENT_STAGE'
  | 'EXPERIMENT_COMMIT'
  | 'EXPERIMENT_ROLLBACK'
  | 'RECIPE_REPLAY'
  | 'RECIPE_INVALIDATED';

export type EventProvenance =
  | 'webRequest'
  | 'webNavigation'
  | 'performance'
  | 'mutationObserver'
  | 'healthVector'
  | 'transactionEngine'
  | 'recipeEngine'
  | 'labCDP'
  | 'semanticObserver'
  | 'navigationIntent'
  | 'windowApi'
  | 'autonomyLab';

export interface EventNode {
  id: `event:${string}`;
  kind: EventKind;
  scope: {
    tabId: number;
    navigationEpoch: number;
    documentId: string;
    frameId: number;
    originHash: string;
  };
  timestamp: Timestamp;
  refs: OpaqueRef[];
  features: Record<string, string | number | boolean | null>;
  provenance: EventProvenance;
  observationConfidence: number; // [0,1]
}

export type EdgeStatus =
  | 'TEMPORAL_CANDIDATE'
  | 'ASSOCIATED'
  | 'INTERVENTION_SUPPORTED'
  | 'INTERVENTION_REFUTED'
  | 'CONFOUNDED_OR_AMBIGUOUS'
  | 'RECIPE_CONFIRMED';

/** Type stub only (M1). Graph logic is M2+. */
export interface EventEdge {
  id: string;
  from: EventNode['id'] | OpaqueRef;
  to: EventNode['id'] | OpaqueRef;
  relation:
    | 'PRECEDES'
    | 'PREDICTS'
    | 'POSSIBLY_CAUSES'
    | 'CAUSES_HEALTH_DELTA'
    | 'TRIGGERS_REACTION'
    | 'DEPENDENCY';
  lagMs?: { min: number; max: number };
  status: EdgeStatus;
  support: {
    observationalN: number;
    interventionN: number;
    positiveN: number;
    negativeN: number;
    bayesFactor?: number;
    posteriorProbability?: number;
    effectMean?: number;
    effectCi95?: [number, number];
  };
  confounders: OpaqueRef[];
  lastUpdatedWallMs: number;
}

/** Type stub only (M1). */
export interface CausalHypothesis {
  id: `hypothesis:h${number}`;
  causeRefs: OpaqueRef[];
  outcome:
    | 'PAGE_BREAKAGE'
    | 'ANTI_BLOCK_REACTION'
    | 'PRIVACY_REGRESSION'
    | 'UNWANTED_NAVIGATION'
    | 'INTERACTION_BLOCKED';
  mechanismClass:
    | 'BLOCKED_RESOURCE_PROBE'
    | 'BAIT_VISIBILITY_PROBE'
    | 'COSMETIC_REMOVAL_DEPENDENCY'
    | 'OVERLAY_REINSERTION'
    | 'SCROLL_LOCK_REACTION'
    | 'SERVICE_WORKER_CACHE_PATH'
    | 'SCRIPT_ORDER_DEPENDENCY'
    | 'UNKNOWN_NETWORK_REACTION'
    | 'UNKNOWN_SCRIPT_REACTION'
    | 'UNKNOWN_DOM_REACTION'
    | 'UNKNOWN_NAVIGATION_REACTION'
    | 'UNKNOWN_PLAYER_REACTION'
    | 'UNKNOWN_MIXED_REACTION'
    | 'UNKNOWN';
  prior: number;
  posterior: number;
  confoundingRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'CANDIDATE' | 'SUPPORTED' | 'REFUTED' | 'CONFIRMED';
  createdFrom: OpaqueRef[];
  updatedByExperiments: `experiment:x${number}`[];
}

/** Type stub only (M1). Compact health used by later experiment records. */
export interface HealthVectorCompact {
  contentAccess: number;
  interaction: number;
  scrollability: number;
  visualObstruction: number;
  mutationStability: number;
  networkIntegrity: number;
  privacyPreservation: number;
  confidence: number;
}

/** Type stub only (M1). */
export interface ExperimentRecord {
  id: `experiment:x${number}`;
  candidateHash: string;
  startedWallMs: number;
  completedWallMs?: number;
  status: 'STAGED' | 'COMMITTED' | 'ROLLED_BACK' | 'ABORTED' | 'STALE';
  preHealth: HealthVectorCompact;
  postHealth?: HealthVectorCompact;
  healthDelta?: number;
  observedRefs: OpaqueRef[];
  policyDecisionId: string;
  transactionId: string;
  rollbackVerified: boolean;
  epochStillFresh: boolean;
  /** Distinct navigation/visit evidence used by promotion; never caller counters. */
  visitId?: string;
  fingerprintHash?: string;
  replay?: boolean;
  privacyScore?: number;
  primitiveId?: string;
  capabilityGapCode?: string;
  policyAbstentionCode?: string;
}

/** Type stub only (M1). */
export interface ExperimentBudget {
  maxPerDocumentEpoch: number;
  maxReloadingExperiments: number;
  maxCumulativeWaitMs: number;
  maxHealthRisk: number;
  maxPrivacyRisk: number;
  minRollbackConfidence: number;
}

/** Type stub only (M1). EventGraph store is M2+. */
export interface EventGraph {
  graphVersion: '3.0';
  graphId: string;
  scope: {
    originHash: string;
    tabId: number;
    navigationEpoch: number;
    documentId: string;
    createdWallMs: number;
  };
  nodes: EventNode[];
  edges: EventEdge[];
  hypotheses: CausalHypothesis[];
  experiments: ExperimentRecord[];
  budgets: ExperimentBudget;
}

let eventSeq = 0;

export function createEventId(): `event:${string}` {
  eventSeq += 1;
  return `event:${Date.now().toString(36)}_${eventSeq.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function scopesEqual(a: CausalDocumentKey, b: CausalDocumentKey): boolean {
  return (
    a.tabId === b.tabId &&
    a.navigationEpoch === b.navigationEpoch &&
    a.documentId === b.documentId &&
    a.frameId === b.frameId
  );
}

/**
 * Incoming is stale if any of tabId / documentId / navigationEpoch / frameId
 * mismatch the live causal key.
 */
export function isStaleScope(live: CausalDocumentKey, incoming: CausalDocumentKey): boolean {
  return !scopesEqual(live, incoming);
}

/**
 * Privacy-preserving SHA-256 hex of an origin. Never put the raw origin into EventNode.scope.originHash.
 */
export function hashOrigin(origin: string): string {
  return sha256HexUtf8(origin);
}

/**
 * Subtract timestamps only inside a single clock domain.
 * Returns null when domains differ — never silently cross-calibrate.
 */
export function timestampDeltaMs(a: Timestamp, b: Timestamp): number | null {
  if (a.domain !== b.domain) return null;
  return a.value - b.value;
}

export function causalKeyFromNode(node: EventNode): CausalDocumentKey {
  return {
    tabId: node.scope.tabId,
    navigationEpoch: node.scope.navigationEpoch,
    documentId: node.scope.documentId,
    frameId: node.scope.frameId,
  };
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256HexUtf8(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLen = bytes.length * 8;
  const withOne = bytes.length + 1;
  const mod = withOne % 64;
  const zeroPad = mod <= 56 ? 56 - mod : 120 - mod;
  const padded = new Uint8Array(withOne + zeroPad + 8);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(offset + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const wt15 = w[t - 15] ?? 0;
      const wt2 = w[t - 2] ?? 0;
      const s0 = rotr(wt15, 7) ^ rotr(wt15, 18) ^ (wt15 >>> 3);
      const s1 = rotr(wt2, 17) ^ rotr(wt2, 19) ^ (wt2 >>> 10);
      w[t] = ((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + (SHA256_K[t] ?? 0) + (w[t] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}
