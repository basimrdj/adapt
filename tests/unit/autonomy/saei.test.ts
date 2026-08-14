import { describe, expect, it } from 'vitest';
import { AutonomousExperimentLoop } from '../../../src/background/autonomy/saei';
import { EventNode } from '../../../src/shared/causal/events';

function node(id: string, kind: EventNode['kind']): EventNode {
  return {
    id: `event:${id}`,
    kind,
    scope: { tabId: 1, navigationEpoch: 1, documentId: 'doc', frameId: 0, originHash: 'origin' },
    timestamp: { value: 1, domain: 'extension.monotonic_ms' },
    refs: ['element:e1'], features: {}, provenance: 'autonomyLab', observationConfidence: 1,
  };
}

describe('SAEI autonomous control loop', () => {
  it('tries multiple bounded variables and promotes a successful recipe', () => {
    const loop = new AutonomousExperimentLoop();
    loop.start({
      events: [node('gate', 'SEMANTIC_GATE'), node('deny', 'INTERACTION_DENIED')],
      health: { pageHealth: 0.6, contentHealth: 0.6, interactionHealth: 0.4, privacyHealth: 1, reactionResolved: false },
      fingerprintHash: 'fp', knownRecipe: false, developerHint: false,
    });
    const first = loop.nextExperiment();
    expect(first).not.toBeNull();
    if (!first) return;
    loop.recordOutcome(first, { resolved: false, pageHealthy: true, healthDelta: 0 });
    const second = loop.nextExperiment();
    expect(second).not.toBeNull();
    if (!second) return;
    const final = loop.recordOutcome(second, { resolved: true, pageHealthy: true, healthDelta: 0.2 });
    expect(final.status).toBe('RESOLVED');
    expect(final.recipe?.fingerprintHash).toBe('fp');
    expect(final.aiCalls).toBe(0);
  });

  it('does not explore a known recipe or developer-hinted trial', () => {
    const loop = new AutonomousExperimentLoop();
    expect(loop.start({
      events: [node('gate', 'ANTI_BLOCK_REACTION')],
      health: { pageHealth: 0.5, contentHealth: 0.5, interactionHealth: 0.5, privacyHealth: 1, reactionResolved: false },
      fingerprintHash: 'fp', knownRecipe: true, developerHint: false,
    }).status).toBe('CAPABILITY_GAP');
    expect(loop.nextExperiment()).toBeNull();
  });
});
