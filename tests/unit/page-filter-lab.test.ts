import { describe, expect, it } from 'vitest';
import corpus from '../fixtures/phase31b/adversarial-corpus.json';

describe('Phase 3.1B adversarial lab corpus', () => {
  it('contains the required broad coverage and negative controls', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(30);
    expect(corpus.filter((entry) => entry.negativeControl)).toHaveLength(4);
    expect(new Set(corpus.map((entry) => entry.id)).size).toBe(corpus.length);
    expect(corpus.some((entry) => entry.id === 'network-ad-request')).toBe(true);
    expect(corpus.some((entry) => entry.id === 'worker-restart')).toBe(true);
    expect(corpus.some((entry) => entry.id === 'open-shadow-dom')).toBe(true);
  });
});
