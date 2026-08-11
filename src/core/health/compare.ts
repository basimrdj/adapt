import { HealthVector, VerificationResult } from '../../shared/types';
import { ADAPT_THRESHOLDS } from '../../shared/constants';

/**
 * Compares pre-experiment baseline health with post-experiment health.
 * Determines objectively whether an adaptation strategy succeeded or failed.
 */
export function verifyHealthOutcome(
  baseline: HealthVector,
  post: HealthVector
): VerificationResult {
  const reactionDelta = post.antiBlockReaction - baseline.antiBlockReaction; // Negative is improvement
  const contentDelta = post.contentAvailability - baseline.contentAvailability;
  const interactionDelta = post.interaction - baseline.interaction;

  // Composite health delta (improvement in reaction + improvement in content + improvement in interaction)
  const scoreDelta = -reactionDelta * 0.5 + contentDelta * 0.3 + interactionDelta * 0.2;

  // Success criteria:
  // 1. Reaction improved meaningfully (dropped by at least 0.30 or dropped to near zero < 0.20)
  // 2. Content availability did not regress significantly
  // 3. Overall interaction is in a usable state (>= 0.70)
  const reactionImproved = reactionDelta <= -0.30 || (baseline.antiBlockReaction >= 0.50 && post.antiBlockReaction <= 0.20);
  const contentPreserved = contentDelta >= ADAPT_THRESHOLDS.MAX_ALLOWED_CONTENT_REGRESSION;
  const interactionHealthy = post.interaction >= 0.70 && post.scrollability >= 0.70;

  const success = reactionImproved && contentPreserved && interactionHealthy;

  let notes = '';
  if (success) {
    notes = `Adaptation succeeded: reaction dropped by ${(Math.abs(reactionDelta) * 100).toFixed(1)}%, content preserved.`;
  } else if (!reactionImproved) {
    notes = `Adaptation failed: reaction score did not improve sufficiently (delta: ${reactionDelta.toFixed(2)}).`;
  } else if (!contentPreserved) {
    notes = `Adaptation failed: main content availability regressed by ${(Math.abs(contentDelta) * 100).toFixed(1)}%.`;
  } else {
    notes = `Adaptation failed: page interaction or scrollability remained locked.`;
  }

  return {
    success,
    scoreDelta,
    reactionDelta,
    contentDelta,
    interactionDelta,
    notes,
    postHealth: post,
  };
}
