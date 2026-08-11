import { PRIORITIES } from '../../shared/constants';

export type PriorityBand =
  | 'STATIC_BASELINE'
  | 'PERSISTED_LEARNED_BLOCK'
  | 'PERSISTED_COMPAT_RULE'
  | 'EXPERIMENT_BLOCK'
  | 'EXPERIMENT_REDIRECT'
  | 'COMPATIBILITY_EXCEPTION'
  | 'USER_OVERRIDE';

export function getPriority(band: PriorityBand, modifier = 0): number {
  const base = PRIORITIES[band];
  return Math.max(1, base + modifier);
}
