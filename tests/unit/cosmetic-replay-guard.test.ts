/**
 * Cosmetic replay guard breakage heuristic (Phase E). A replayed hide only
 * counts as breakage when the hidden subtree carried substantial content AND
 * the page's remaining visible text collapsed. Pins the sparse-page regression:
 * a correctly hidden gate overlay on a text-light page must never report broke
 * (the background answers broke with removeCSS, un-hiding the gate mid-visit
 * and burning the rule's failure budget).
 */
import { describe, it, expect } from 'vitest';
import { cosmeticReplayLooksBroken } from '../../src/page/stealth/cosmetic-guard';

describe('cosmeticReplayLooksBroken', () => {
  it('does not report breakage for a correctly hidden gate on a sparse page', () => {
    // Gate overlay copy is short; the host page itself is text-light.
    expect(cosmeticReplayLooksBroken(1, 72, 48)).toBe(false);
  });

  it('reports breakage when the hidden subtree carried the page content', () => {
    // Selector drifted onto the main content root: hiding removed thousands
    // of characters and almost nothing remains visible.
    expect(cosmeticReplayLooksBroken(1, 4200, 12)).toBe(true);
  });

  it('does not report breakage when nothing matched', () => {
    expect(cosmeticReplayLooksBroken(0, 0, 0)).toBe(false);
  });

  it('does not report breakage while plenty of text remains visible', () => {
    expect(cosmeticReplayLooksBroken(1, 4200, 1500)).toBe(false);
  });

  it('boundary: exactly the hidden-text floor reports broken', () => {
    expect(cosmeticReplayLooksBroken(1, 200, 79)).toBe(true);
    expect(cosmeticReplayLooksBroken(1, 199, 79)).toBe(false);
  });

  it('boundary: exactly the visible-text ceiling is not broken', () => {
    expect(cosmeticReplayLooksBroken(1, 200, 80)).toBe(false);
  });
});
