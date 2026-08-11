import { PageSignalBatch, StrategyCandidate } from '../../shared/types';

export class StrategyCandidateGenerator {
  /**
   * Proposes ranked strategy candidates according to the Strategy Ladder (S1–S5).
   */
  public generateCandidates(batch: PageSignalBatch): StrategyCandidate[] {
    const candidates: StrategyCandidate[] = [];
    const { geometry, interaction } = batch;

    // S3: Reaction UI Removal & Scroll Restoration (if full screen overlay / locked scroll detected)
    if (geometry.hasFixedOverlay || geometry.bodyScrollLocked || geometry.htmlScrollLocked || interaction.pointerEventsSuppressed) {
      candidates.push({
        id: `cand_s3_${Date.now()}`,
        tier: 'S3',
        name: 'Reaction UI Removal & Scroll Restoration',
        rationale: 'Detected full-screen obstruction or scroll lock; removing overlay and unlocking body scroll.',
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

    // S2: Preserve Suspected Bait Element Layout
    candidates.push({
      id: `cand_s2_${Date.now()}`,
      tier: 'S2',
      name: 'Preserve Harmless Bait Layout',
      rationale: 'Preserves non-intrusive layout dimensions for dummy bait containers to satisfy detector queries.',
      isReversible: true,
      estimatedRisk: 'LOW',
      actions: [
        {
          id: `dom_bait_${Date.now()}`,
          type: 'DOM_PRESERVE_BAIT_CANDIDATE',
          selector: '.ad-banner, #ad-container, .advertisement, [id*="google_ads"]',
        },
      ],
    });

    // S1: Cosmetic Rollback
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

    return candidates;
  }
}
