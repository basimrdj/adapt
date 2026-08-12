import { PageSignalBatch, HealthVector } from '../../shared/types';
import { DEFAULT_HEALTH_WEIGHTS, HealthWeights } from './model';

/**
 * Calculates a multidimensional HealthVector from page signals.
 */
export function calculateHealthVector(
  batch: PageSignalBatch,
  weights: HealthWeights = DEFAULT_HEALTH_WEIGHTS
): HealthVector {
  const { geometry, semantic, interaction, mutation } = batch;

  // 1. Anti-Block Reaction Score (0..1, LOWER is better)
  const semanticScore =
    typeof semantic.confidenceScore === 'number'
      ? semantic.confidenceScore
      : semantic.detectedPhrases.length > 0
      ? 0.85
      : 0;
  const geometryScore = geometry.hasFixedOverlay ? Math.min(1, (geometry.overlayCoverageRatio || 0) * 1.2) : 0;
  const interactionScore =
    (interaction.pointerEventsSuppressed ? 0.6 : 0) +
    (geometry.bodyScrollLocked || geometry.htmlScrollLocked ? 0.4 : 0);
  const mutationScore = mutation.rapidReinsertionDetected ? 0.8 : 0;

  const weightedSum =
    (semanticScore || 0) * weights.semantic +
    (geometryScore || 0) * weights.geometry +
    (interactionScore || 0) * weights.interaction +
    (mutationScore || 0) * weights.mutation;

  // If page exhibits clear semantic reaction or mutation burst, reflect high anti-block confidence
  const antiBlockReaction = Math.min(
    1,
    Math.max(
      weightedSum,
      semanticScore >= 0.8 ? semanticScore * 0.85 : 0,
      mutation.rapidReinsertionDetected ? 0.75 : 0
    )
  );

  // 2. Content Availability (0..1, HIGHER is better)
  let contentAvailability = 1.0;
  if (geometry.mainContentHidden) {
    contentAvailability -= 0.7;
  }
  if (interaction.contentCovered) {
    contentAvailability -= 0.4;
  }
  contentAvailability = Math.max(0, Math.min(1, contentAvailability));

  // 3. Interaction & Scrollability
  const interactionHealth = interaction.pointerEventsSuppressed ? 0.1 : 1.0;
  const scrollability = geometry.bodyScrollLocked || geometry.htmlScrollLocked ? 0.1 : 1.0;

  // 4. Visual Obstruction
  const visualObstruction = geometry.overlayCoverageRatio;

  // 5. Mutation Stability
  let mutationStability = 1.0;
  if (mutation.degradationState === 'PAUSED') mutationStability = 0.2;
  else if (mutation.degradationState === 'SAMPLING') mutationStability = 0.5;
  else if (mutation.degradationState === 'COALESCED') mutationStability = 0.8;

  // 6. Confidence
  const confidence = Math.min(
    1,
    0.5 + (semantic.detectedPhrases.length > 0 ? 0.3 : 0) + (geometry.hasFixedOverlay ? 0.2 : 0)
  );

  return {
    antiBlockReaction,
    contentAvailability,
    interaction: interactionHealth,
    scrollability,
    navigationHealth: 1.0,
    visualObstruction,
    mutationStability,
    confidence,
  };
}
