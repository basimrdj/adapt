import { HealthVector, PageSignalBatch, DomAction, StrategyCandidate, SiteRecipe, UserIntentEnvelope } from './types';

/**
 * Deep runtime schema guards to reject untrusted, malformed, or malicious messages.
 */

export function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function isNumber(val: unknown): val is number {
  return typeof val === 'number' && !Number.isNaN(val) && Number.isFinite(val);
}

export function isString(val: unknown): val is string {
  return typeof val === 'string';
}

export function isBoolean(val: unknown): val is boolean {
  return typeof val === 'boolean';
}

export function isHealthVector(val: unknown): val is HealthVector {
  if (!isObject(val)) return false;
  return (
    isNumber(val.antiBlockReaction) &&
    isNumber(val.contentAvailability) &&
    isNumber(val.interaction) &&
    isNumber(val.scrollability) &&
    isNumber(val.navigationHealth) &&
    isNumber(val.visualObstruction) &&
    isNumber(val.mutationStability) &&
    isNumber(val.confidence)
  );
}

export function isPageSignalBatch(val: unknown): val is PageSignalBatch {
  if (!isObject(val)) return false;
  if (!isString(val.navigationId) || !isNumber(val.timestamp)) return false;

  const geo = val.geometry;
  if (
    !isObject(geo) ||
    !isNumber(geo.viewportWidth) ||
    !isNumber(geo.viewportHeight) ||
    !isBoolean(geo.hasFixedOverlay) ||
    !isNumber(geo.overlayCoverageRatio) ||
    !isBoolean(geo.bodyScrollLocked) ||
    !isBoolean(geo.htmlScrollLocked)
  ) {
    return false;
  }

  const sem = val.semantic;
  if (
    !isObject(sem) ||
    !Array.isArray(sem.detectedPhrases) ||
    !isNumber(sem.adblockKeywordDensity) ||
    !isNumber(sem.confidenceScore)
  ) {
    return false;
  }

  const inter = val.interaction;
  if (
    !isObject(inter) ||
    !isBoolean(inter.pointerEventsSuppressed) ||
    !isBoolean(inter.bodyOverflowHidden) ||
    !isBoolean(inter.contentCovered)
  ) {
    return false;
  }

  const mut = val.mutation;
  if (
    !isObject(mut) ||
    !isNumber(mut.mutationRatePerSecond) ||
    !isBoolean(mut.rapidReinsertionDetected) ||
    !isString(mut.degradationState)
  ) {
    return false;
  }

  return true;
}

export function isUserIntentEnvelope(val: unknown): val is UserIntentEnvelope {
  if (!isObject(val)) return false;
  return (
    isString(val.ref) && /^intent:i\d+$/.test(val.ref) &&
    isNumber(val.documentMonotonicMs) && isNumber(val.capturedWallMs) &&
    isString(val.elementRef) && /^element:e\d+$/.test(val.elementRef) &&
    isString(val.elementRole) && isString(val.declaredDestinationClass) &&
    isNumber(val.button) && Array.isArray(val.modifiers) &&
    val.modifiers.every(isString) && isString(val.interactionType) &&
    isBoolean(val.navigationReasonablyExpected) && isString(val.sourceOriginHash)
  );
}

export function isDomAction(val: unknown): val is DomAction {
  if (!isObject(val)) return false;
  if (!isString(val.id) || !isString(val.type)) return false;
  const validTypes = [
    'DOM_HIDE',
    'DOM_COLLAPSE',
    'DOM_RESTORE',
    'DOM_REMOVE_OVERLAY',
    'DOM_RESTORE_SCROLL',
    'DOM_RESTORE_POINTER_EVENTS',
    'DOM_PRESERVE_BAIT_CANDIDATE',
    'BAIT_PRESERVE_LAYOUT',
    'BAIT_RESTORE_VISIBILITY',
    'BAIT_DISABLE_COSMETIC_HIDE',
    'BAIT_PRESERVE_CHILD_STRUCTURE',
  ];
  if (!validTypes.includes(val.type)) return false;
  if (String(val.type).startsWith('BAIT_') || val.type === 'DOM_PRESERVE_BAIT_CANDIDATE') {
    return isString(val.targetRef) && /^element:e\d+$/.test(val.targetRef) && val.selector === undefined;
  }
  return true;
}

export function isStrategyCandidate(val: unknown): val is StrategyCandidate {
  if (!isObject(val)) return false;
  return (
    isString(val.id) &&
    isString(val.tier) &&
    isString(val.name) &&
    isString(val.rationale) &&
    Array.isArray(val.actions) &&
    isBoolean(val.isReversible)
  );
}

export function isSiteRecipe(val: unknown): val is SiteRecipe {
  if (!isObject(val)) return false;
  if (
    !isNumber(val.schemaVersion) ||
    !isString(val.siteKey) ||
    !isObject(val.match) ||
    !Array.isArray(val.actions) ||
    !isObject(val.evidence) ||
    !isString(val.state) ||
    !isNumber(val.createdAt)
  ) {
    return false;
  }

  const ev = val.evidence;
  if (!isNumber(ev.successfulNavigations) || !isNumber(ev.confidence)) {
    return false;
  }

  return true;
}
