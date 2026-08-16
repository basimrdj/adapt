import { CausalHypothesis, EventNode, OpaqueRef } from '../../shared/causal/events';

export type HypothesisFamily = CausalHypothesis['mechanismClass'];

const UNKNOWN_FAMILIES: readonly HypothesisFamily[] = [
  'UNKNOWN_NETWORK_REACTION',
  'UNKNOWN_SCRIPT_REACTION',
  'UNKNOWN_DOM_REACTION',
  'UNKNOWN_NAVIGATION_REACTION',
  'UNKNOWN_PLAYER_REACTION',
  'UNKNOWN_MIXED_REACTION',
];

function familiesFor(nodes: readonly EventNode[]): HypothesisFamily[] {
  const kinds = new Set(nodes.map((node) => node.kind));
  const result = new Set<HypothesisFamily>();
  if (
    kinds.has('REQUEST_ERROR')
    || kinds.has('NETWORK_PROBE_REACTION')
    || (kinds.has('REQUEST_COMPLETE') && kinds.has('VISIBLE_AD_CANDIDATE'))
  ) result.add('UNKNOWN_NETWORK_REACTION');
  if (
    kinds.has('ANTI_BLOCK_REACTION')
    || kinds.has('SEMANTIC_GATE')
    || kinds.has('INTERACTION_DENIED')
    || kinds.has('OVERLAY_APPEARED')
    || kinds.has('SCROLL_LOCK_ON')
  ) {
    result.add('UNKNOWN_SCRIPT_REACTION');
    result.add('UNKNOWN_DOM_REACTION');
  }
  if (kinds.has('PLAYBACK_OBSTRUCTED')) result.add('UNKNOWN_PLAYER_REACTION');
  if (kinds.has('UNEXPECTED_NAV_TARGET') || kinds.has('POPUP_OR_POPUNDER') || kinds.has('WINDOW_OPEN_REACTION') || kinds.has('SUSPICIOUS_REDIRECT_CHAIN') || kinds.has('INTENT_OUTCOME_FANOUT')) {
    result.add('UNKNOWN_NAVIGATION_REACTION');
  }
  if (kinds.has('UNKNOWN_REACTION') || kinds.has('REPEATED_REINSERTION')) result.add('UNKNOWN_MIXED_REACTION');
  return [...result];
}

function refsFor(nodes: readonly EventNode[], families: readonly HypothesisFamily[]): OpaqueRef[] {
  const relevant = nodes.filter((node) => {
    if (families.includes('UNKNOWN_NAVIGATION_REACTION')) return ['UNEXPECTED_NAV_TARGET', 'POPUP_OR_POPUNDER', 'WINDOW_OPEN_REACTION', 'SUSPICIOUS_REDIRECT_CHAIN', 'INTENT_OUTCOME_FANOUT'].includes(node.kind);
    if (families.includes('UNKNOWN_NETWORK_REACTION')) {
      return ['REQUEST_ERROR', 'NETWORK_PROBE_REACTION', 'REQUEST_COMPLETE', 'VISIBLE_AD_CANDIDATE'].includes(node.kind);
    }
    return [
      'ANTI_BLOCK_REACTION',
      'SEMANTIC_GATE',
      'INTERACTION_DENIED',
      'PLAYBACK_OBSTRUCTED',
      'UNKNOWN_REACTION',
      'REPEATED_REINSERTION',
      'OVERLAY_APPEARED',
      'SCROLL_LOCK_ON',
    ].includes(node.kind);
  });
  return relevant.flatMap((node) => [node.id, ...node.refs]);
}

function nextId(existing: readonly CausalHypothesis[]): `hypothesis:h${number}` {
  const max = existing.reduce((value, item) => {
    const parsed = Number(item.id.slice('hypothesis:h'.length));
    return Number.isFinite(parsed) ? Math.max(value, parsed) : value;
  }, 0);
  return `hypothesis:h${max + 1}`;
}

function outcomeFor(family: HypothesisFamily): CausalHypothesis['outcome'] {
  if (family === 'UNKNOWN_NAVIGATION_REACTION') return 'UNWANTED_NAVIGATION';
  if (family === 'UNKNOWN_PLAYER_REACTION') return 'INTERACTION_BLOCKED';
  return 'ANTI_BLOCK_REACTION';
}

function riskFor(family: HypothesisFamily): CausalHypothesis['confoundingRisk'] {
  if (family === 'UNKNOWN_MIXED_REACTION' || family === 'UNKNOWN_NAVIGATION_REACTION') return 'HIGH';
  if (family === 'UNKNOWN_SCRIPT_REACTION') return 'MEDIUM';
  return 'LOW';
}

export function generateHypothesisLattice(
  nodes: readonly EventNode[],
  existing: readonly CausalHypothesis[] = []
): CausalHypothesis[] {
  const families = familiesFor(nodes);
  const existingFamilies = new Set(existing.map((item) => item.mechanismClass));
  let allocated = [...existing];
  for (const family of UNKNOWN_FAMILIES) {
    if (!families.includes(family) || existingFamilies.has(family)) continue;
    const refs = refsFor(nodes, [family]);
    if (refs.length === 0) continue;
    allocated = [
      ...allocated,
      {
        id: nextId(allocated),
        causeRefs: refs,
        outcome: outcomeFor(family),
        mechanismClass: family,
        prior: family === 'UNKNOWN_MIXED_REACTION' ? 0.08 : 0.12,
        posterior: family === 'UNKNOWN_MIXED_REACTION' ? 0.08 : 0.12,
        confoundingRisk: riskFor(family),
        status: 'CANDIDATE',
        createdFrom: refs.filter((ref) => ref.startsWith('event:')),
        updatedByExperiments: [],
      },
    ];
  }
  return allocated;
}

export function isUnknownHypothesis(family: HypothesisFamily): boolean {
  return UNKNOWN_FAMILIES.includes(family);
}
