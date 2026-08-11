import { describe, it, expect } from 'vitest';
import { calculateHealthVector } from '../../src/core/health/scorer';
import { PageSignalBatch } from '../../src/shared/types';

describe('Health Scorer', () => {
  it('computes clean health on normal unblocked page', () => {
    const batch: PageSignalBatch = {
      navigationId: 'nav_1',
      timestamp: Date.now(),
      geometry: {
        viewportWidth: 1024,
        viewportHeight: 768,
        hasFixedOverlay: false,
        overlayCoverageRatio: 0,
        bodyScrollLocked: false,
        htmlScrollLocked: false,
        modalCount: 0,
        mainContentHidden: false,
        mainContentHeight: 1200,
      },
      semantic: {
        detectedPhrases: [],
        adblockKeywordDensity: 0,
        confidenceScore: 0,
      },
      interaction: {
        pointerEventsSuppressed: false,
        bodyOverflowHidden: false,
        contentCovered: false,
      },
      mutation: {
        mutationRatePerSecond: 0,
        rapidReinsertionDetected: false,
        overlayReinsertedCount: 0,
        degradationState: 'NORMAL',
      },
      suspectedDetectorTypes: [],
    };

    const health = calculateHealthVector(batch);
    expect(health.antiBlockReaction).toBeLessThan(0.1);
    expect(health.contentAvailability).toBe(1.0);
    expect(health.interaction).toBe(1.0);
    expect(health.scrollability).toBe(1.0);
  });

  it('detects high anti-block reaction on gated overlay page', () => {
    const batch: PageSignalBatch = {
      navigationId: 'nav_2',
      timestamp: Date.now(),
      geometry: {
        viewportWidth: 1024,
        viewportHeight: 768,
        hasFixedOverlay: true,
        overlayCoverageRatio: 0.95,
        bodyScrollLocked: true,
        htmlScrollLocked: true,
        modalCount: 1,
        mainContentHidden: false,
        mainContentHeight: 800,
      },
      semantic: {
        detectedPhrases: ['disable your ad blocker', 'ads support us'],
        adblockKeywordDensity: 0.05,
        confidenceScore: 0.85,
      },
      interaction: {
        pointerEventsSuppressed: true,
        bodyOverflowHidden: true,
        contentCovered: true,
      },
      mutation: {
        mutationRatePerSecond: 10,
        rapidReinsertionDetected: false,
        overlayReinsertedCount: 0,
        degradationState: 'NORMAL',
      },
      suspectedDetectorTypes: ['FULLSCREEN_GATE', 'SEMANTIC_PROMPT', 'SCROLL_LOCK'],
    };

    const health = calculateHealthVector(batch);
    expect(health.antiBlockReaction).toBeGreaterThan(0.70);
    expect(health.contentAvailability).toBeLessThan(0.70);
    expect(health.interaction).toBeLessThan(0.50);
    expect(health.scrollability).toBeLessThan(0.50);
  });
});
