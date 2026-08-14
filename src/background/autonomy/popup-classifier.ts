import { NavigationTargetObservation } from '../../shared/types';

export type PopupDisposition =
  | 'OBSERVE_ONLY'
  | 'QUARANTINE_TARGET'
  | 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET'
  | 'SESSION_BLOCK_TARGET_CHAIN'
  | 'SUPPRESS_MATCHED_WINDOW_OPEN_BEHAVIOR';

export interface PopupClassification {
  disposition: PopupDisposition;
  confidence: number;
  evidence: string[];
  negativeControl: boolean;
}

const LEGITIMATE_DESTINATIONS = new Set(['same-origin', 'oauth-like', 'payment-like', 'document']);

export function classifyNavigationTarget(target: NavigationTargetObservation): PopupClassification {
  const evidence = [...target.riskSignals];
  const legitimate = LEGITIMATE_DESTINATIONS.has(target.destinationClass);
  const explicit = target.openerRelationship === 'explicit';
  if (legitimate && explicit && !evidence.includes('REDIRECT_CHAIN')) {
    return { disposition: 'OBSERVE_ONLY', confidence: 0.05, evidence, negativeControl: true };
  }

  let confidence = 0;
  if (evidence.includes('NO_RECENT_INTENT')) confidence += 0.35;
  if (evidence.includes('UNEXPECTED_AFTER_GESTURE')) confidence += 0.3;
  if (evidence.includes('MEDIA_GESTURE_TARGET')) confidence += 0.15;
  if (evidence.includes('CROSS_ORIGIN_TARGET')) confidence += 0.1;
  if (evidence.includes('BACKGROUND_TARGET')) confidence += 0.05;
  if (evidence.includes('REDIRECT_CHAIN')) confidence += 0.15;
  if (legitimate) confidence -= 0.45;
  confidence = Math.max(0, Math.min(1, confidence));

  if (confidence >= 0.85) {
    return { disposition: 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET', confidence, evidence, negativeControl: false };
  }
  if (confidence >= 0.55) {
    return { disposition: 'QUARANTINE_TARGET', confidence, evidence, negativeControl: false };
  }
  return { disposition: 'OBSERVE_ONLY', confidence, evidence, negativeControl: legitimate };
}
