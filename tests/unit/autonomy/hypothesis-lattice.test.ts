import { describe, expect, it } from 'vitest';
import { generateHypothesisLattice } from '../../../src/background/autonomy/hypothesis-lattice';
import { EventNode } from '../../../src/shared/causal/events';

function node(id: string, kind: EventNode['kind'], refs: EventNode['refs'] = []): EventNode {
  return {
    id: `event:${id}`,
    kind,
    scope: { tabId: 1, navigationEpoch: 1, documentId: 'doc', frameId: 0, originHash: 'origin' },
    timestamp: { value: 1, domain: 'extension.monotonic_ms' },
    refs,
    features: {},
    provenance: 'autonomyLab',
    observationConfidence: 1,
  };
}

describe('unknown hypothesis lattice', () => {
  it('generates competing families from navigation and semantic reactions', () => {
    const hypotheses = generateHypothesisLattice([
      node('nav', 'UNEXPECTED_NAV_TARGET', ['navigation:n1']),
      node('gate', 'SEMANTIC_GATE'),
    ]);
    expect(hypotheses.map((item) => item.mechanismClass)).toEqual(expect.arrayContaining([
      'UNKNOWN_NAVIGATION_REACTION',
      'UNKNOWN_SCRIPT_REACTION',
      'UNKNOWN_DOM_REACTION',
    ]));
    expect(hypotheses.length).toBeGreaterThan(1);
  });

  it('preserves existing posteriors and does not duplicate families', () => {
    const first = generateHypothesisLattice([node('gate', 'ANTI_BLOCK_REACTION')]);
    const updated = generateHypothesisLattice([node('gate', 'ANTI_BLOCK_REACTION'), node('more', 'UNKNOWN_REACTION')], first);
    expect(updated.filter((item) => item.mechanismClass === 'UNKNOWN_SCRIPT_REACTION')).toHaveLength(1);
    expect(updated.filter((item) => item.mechanismClass === 'UNKNOWN_DOM_REACTION')).toHaveLength(1);
  });
});
