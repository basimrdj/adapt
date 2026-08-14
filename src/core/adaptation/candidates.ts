import { PageSignalBatch, StrategyCandidate } from '../../shared/types';

export class StrategyCandidateGenerator {
  /**
   * Proposes ranked strategy candidates according to the Strategy Ladder (S1–S5).
   * If no specific deterministic heuristic matches, returns an empty array to allow AI escalation.
   */
  public generateCandidates(batch: PageSignalBatch): StrategyCandidate[] {
    const candidates: StrategyCandidate[] = [];
    const { geometry, interaction, semantic, suspectedDetectorTypes } = batch;

    // S3: Reaction UI Removal & Scroll Restoration (if full screen overlay / locked scroll detected)
    if (
      geometry.hasFixedOverlay ||
      geometry.bodyScrollLocked ||
      geometry.htmlScrollLocked ||
      interaction.pointerEventsSuppressed
    ) {
      candidates.push({
        id: `cand_s3_${Date.now()}`,
        tier: 'S3',
        name: 'Reaction UI Removal & Scroll Restoration',
        rationale:
          'Detected full-screen obstruction or scroll lock; removing overlay and unlocking body scroll.',
        isReversible: true,
        estimatedRisk: 'LOW',
        actions: [
          {
            id: `dom_overlay_${Date.now()}`,
            type: 'DOM_REMOVE_OVERLAY',
          },
          {
            id: `dom_scroll_${Date.now()}`,
            type: 'DOM_RESTORE_SCROLL',
          },
          {
            id: `dom_pointer_${Date.now()}`,
            type: 'DOM_RESTORE_POINTER_EVENTS',
          },
        ],
      });
    }

    // S2 bait actions require an opaque element ref from the observation plane.
    // This signal-only generator has no refs, so it must not invent selectors.
    if (
      suspectedDetectorTypes.includes('BAIT_DETECTOR') ||
      semantic.detectedPhrases.some((p) => p.toLowerCase().includes('bait'))
    ) {
      return candidates;
    }

    // S1: Cosmetic Filter Rollback (only if cosmetic collapse identified)
    if (suspectedDetectorTypes.includes('COSMETIC_COLLAPSE')) {
      candidates.push({
        id: `cand_s1_${Date.now()}`,
        tier: 'S1',
        name: 'Cosmetic Filter Rollback',
        rationale: 'Rolls back aggressive cosmetic element hiding on the current origin.',
        isReversible: true,
        estimatedRisk: 'LOW',
        actions: [
          {
            id: `dom_restore_${Date.now()}`,
            type: 'DOM_RESTORE',
          },
        ],
      });
    }

    return candidates;
  }
}
