import { CausalHypothesis } from '../../shared/causal/events';

export type PrimitiveId =
  | 'TEMPORARY_NETWORK_ALLOW'
  | 'TEMPORARY_NETWORK_BLOCK'
  | 'TARGETED_SESSION_DNR'
  | 'TOGGLE_COSMETIC_ACTION'
  | 'PRESERVE_BAIT'
  | 'RESTORE_LAYOUT'
  | 'REMOVE_REACTION_UI'
  | 'RESTORE_SCROLL'
  | 'RESTORE_POINTER_INTERACTION'
  | 'ACTIVATE_PACKAGED_SCRIPTLET'
  | 'DISABLE_PACKAGED_SCRIPTLET'
  | 'QUARANTINE_NAVIGATION_TARGET'
  | 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
  | 'SUPPRESS_MATCHED_WINDOW_OPEN_BEHAVIOR'
  | 'STOP_MATCHED_REDIRECT_CHAIN'
  | 'PLAYER_HEALTH_RECOVERY';

export type PrimitiveExecutionWorld = 'background' | 'isolated-world' | 'main-world';

export interface PrimitiveDefinition {
  id: PrimitiveId;
  allowedMechanisms: readonly CausalHypothesis['mechanismClass'][];
  requiredEvidence: readonly string[];
  parameterSchema: readonly string[];
  executionWorld: PrimitiveExecutionWorld;
  riskScore: number;
  privacyScore: number;
  rollbackMethod: string;
  expectedObservableEffect: string;
  forbiddenContexts: readonly string[];
}

export interface PrimitiveProposal {
  primitiveId: PrimitiveId;
  mechanism: CausalHypothesis['mechanismClass'];
  opaqueRefs: readonly string[];
  evidence: readonly string[];
  parameters?: Readonly<Record<string, string | number | boolean>>;
}

export type PrimitiveValidation =
  | { ok: true; definition: PrimitiveDefinition }
  | { ok: false; reason: string };

const FORBIDDEN_TOKENS = /javascript:|eval\s*\(|new\s+function|document\.cookie|authorization|password|paywall|drm|purchase|checkout|form/i;
const OPAQUE_REF = /^(event|element|request|resource|frame|intent|navigation|primitive|strategy|hypothesis|experiment|recipe):[^\s]+$/;

function definition(
  id: PrimitiveId,
  allowedMechanisms: readonly CausalHypothesis['mechanismClass'][],
  requiredEvidence: readonly string[],
  executionWorld: PrimitiveExecutionWorld,
  riskScore: number,
  privacyScore: number,
  rollbackMethod: string,
  expectedObservableEffect: string,
  parameterSchema: readonly string[] = [],
  forbiddenContexts: readonly string[] = []
): PrimitiveDefinition {
  return {
    id,
    allowedMechanisms,
    requiredEvidence,
    parameterSchema,
    executionWorld,
    riskScore,
    privacyScore,
    rollbackMethod,
    expectedObservableEffect,
    forbiddenContexts,
  };
}

export const PRIMITIVE_DEFINITIONS: readonly PrimitiveDefinition[] = [
  definition('TEMPORARY_NETWORK_ALLOW', ['BLOCKED_RESOURCE_PROBE', 'UNKNOWN_NETWORK_REACTION'], ['REQUEST_ERROR'], 'background', 0.08, 0.03, 'remove session rule', 'probe becomes reachable', ['requestRef']),
  definition('TEMPORARY_NETWORK_BLOCK', ['UNKNOWN_NETWORK_REACTION', 'UNKNOWN_MIXED_REACTION'], ['REQUEST_START'], 'background', 0.06, 0.01, 'remove session rule', 'suspicious resource stops', ['requestRef']),
  definition('TARGETED_SESSION_DNR', ['UNKNOWN_NETWORK_REACTION'], ['REQUEST_START', 'VISIBLE_AD_CANDIDATE'], 'background', 0.08, 0.01, 'remove session rule', 'matched request is blocked', ['requestRef']),
  definition('TOGGLE_COSMETIC_ACTION', ['UNKNOWN_DOM_REACTION', 'COSMETIC_REMOVAL_DEPENDENCY'], ['CONTENT_VISIBILITY_CHANGED'], 'isolated-world', 0.1, 0.01, 'restore prior state', 'layout changes without destructive removal', ['elementRef']),
  definition('PRESERVE_BAIT', ['BAIT_VISIBILITY_PROBE', 'COSMETIC_REMOVAL_DEPENDENCY', 'UNKNOWN_DOM_REACTION', 'UNKNOWN_MIXED_REACTION'], ['BAIT_STATE_CHANGED'], 'isolated-world', 0.03, 0, 'restore prior state', 'bait remains measurable', ['elementRef']),
  definition('RESTORE_LAYOUT', ['UNKNOWN_DOM_REACTION', 'UNKNOWN_MIXED_REACTION'], ['CONTENT_HEIGHT_CHANGED', 'ANTI_BLOCK_REACTION'], 'isolated-world', 0.08, 0.01, 'restore prior state', 'content geometry returns to baseline', ['elementRef']),
  definition('REMOVE_REACTION_UI', ['OVERLAY_REINSERTION', 'UNKNOWN_DOM_REACTION', 'UNKNOWN_MIXED_REACTION'], ['ANTI_BLOCK_REACTION', 'SEMANTIC_GATE'], 'isolated-world', 0.14, 0.01, 'restore prior state', 'reaction UI no longer obstructs content', ['elementRef']),
  definition('RESTORE_SCROLL', ['SCROLL_LOCK_REACTION', 'UNKNOWN_PLAYER_REACTION', 'UNKNOWN_DOM_REACTION'], ['SCROLL_LOCK_ON'], 'isolated-world', 0.05, 0, 'restore prior state', 'scrolling is available'),
  definition('RESTORE_POINTER_INTERACTION', ['SCROLL_LOCK_REACTION', 'UNKNOWN_PLAYER_REACTION', 'UNKNOWN_DOM_REACTION'], ['INTERACTION_DENIED'], 'isolated-world', 0.05, 0, 'restore prior state', 'pointer interaction is available'),
  definition('ACTIVATE_PACKAGED_SCRIPTLET', ['UNKNOWN_SCRIPT_REACTION', 'SCRIPT_ORDER_DEPENDENCY'], ['ANTI_BLOCK_REACTION'], 'main-world', 0.16, 0.02, 'disable packaged scriptlet', 'known packaged behavior changes', ['scriptletId']),
  definition('DISABLE_PACKAGED_SCRIPTLET', ['UNKNOWN_SCRIPT_REACTION', 'SCRIPT_ORDER_DEPENDENCY'], ['PLAYBACK_OBSTRUCTED', 'INTERACTION_DENIED'], 'main-world', 0.12, 0.02, 'restore packaged scriptlet state', 'known packaged behavior stops'),
  definition('QUARANTINE_NAVIGATION_TARGET', ['UNKNOWN_NAVIGATION_REACTION'], ['UNEXPECTED_NAV_TARGET', 'POPUP_OR_POPUNDER'], 'background', 0.12, 0.01, 'undo quarantine', 'unexpected target is isolated', ['navigationRef']),
  definition('CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET', ['UNKNOWN_NAVIGATION_REACTION'], ['UNEXPECTED_NAV_TARGET', 'POPUP_OR_POPUNDER'], 'background', 0.28, 0.01, 'restore closed target', 'high-confidence unwanted target closes', ['navigationRef'], ['authentication', 'oauth-like', 'payment-like', 'document']),
  definition('SUPPRESS_MATCHED_WINDOW_OPEN_BEHAVIOR', ['UNKNOWN_NAVIGATION_REACTION'], ['WINDOW_OPEN_REACTION'], 'isolated-world', 0.2, 0.02, 'restore window behavior', 'matched popup behavior is suppressed', ['intentRef']),
  definition('STOP_MATCHED_REDIRECT_CHAIN', ['UNKNOWN_NAVIGATION_REACTION'], ['SUSPICIOUS_REDIRECT_CHAIN', 'NAVIGATION_BOUNCE'], 'background', 0.16, 0.01, 'remove session rule', 'redirect chain stops', ['navigationRef']),
  definition('PLAYER_HEALTH_RECOVERY', ['UNKNOWN_PLAYER_REACTION'], ['PLAYBACK_OBSTRUCTED', 'INTERACTION_DENIED'], 'isolated-world', 0.12, 0.01, 'restore prior player state', 'player interaction recovers', ['elementRef']),
];

export class PrimitiveRegistry {
  private readonly definitions = new Map(PRIMITIVE_DEFINITIONS.map((item) => [item.id, item]));

  get(id: PrimitiveId): PrimitiveDefinition | undefined {
    return this.definitions.get(id);
  }

  list(): readonly PrimitiveDefinition[] {
    return PRIMITIVE_DEFINITIONS;
  }

  validate(proposal: PrimitiveProposal): PrimitiveValidation {
    const item = this.definitions.get(proposal.primitiveId);
    if (!item) return { ok: false, reason: 'unknown primitive' };
    if (!item.allowedMechanisms.includes(proposal.mechanism)) return { ok: false, reason: 'mechanism not allowed' };
    if (proposal.opaqueRefs.some((ref) => !OPAQUE_REF.test(ref))) return { ok: false, reason: 'non-opaque reference' };
    if (proposal.evidence.some((item) => FORBIDDEN_TOKENS.test(item))) return { ok: false, reason: 'forbidden evidence token' };
    if (item.requiredEvidence.some((required) => !proposal.evidence.includes(required))) return { ok: false, reason: 'required evidence missing' };
    const supplied = new Set(Object.keys(proposal.parameters ?? {}));
    if ([...supplied].some((key) => !item.parameterSchema.includes(key))) return { ok: false, reason: 'parameter outside schema' };
    if (item.forbiddenContexts.some((context) => proposal.evidence.includes(context))) return { ok: false, reason: 'forbidden context' };
    return { ok: true, definition: item };
  }
}

export class AutonomyPolicyValidator {
  constructor(private readonly registry = new PrimitiveRegistry()) {}

  approve(proposal: PrimitiveProposal, policy: { maxRisk: number; maxPrivacy: number; requiredRollbackConfidence: number; rollbackConfidence: number }): PrimitiveValidation {
    const validation = this.registry.validate(proposal);
    if (!validation.ok) return validation;
    if (validation.definition.riskScore > policy.maxRisk) return { ok: false, reason: 'risk ceiling exceeded' };
    if (validation.definition.privacyScore > policy.maxPrivacy) return { ok: false, reason: 'privacy ceiling exceeded' };
    if (policy.rollbackConfidence < policy.requiredRollbackConfidence) return { ok: false, reason: 'rollback confidence too low' };
    return validation;
  }
}
