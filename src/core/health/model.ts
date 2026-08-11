import { HealthVector } from '../../shared/types';

export interface HealthWeights {
  semantic: number;
  geometry: number;
  interaction: number;
  mutation: number;
}

export const DEFAULT_HEALTH_WEIGHTS: HealthWeights = {
  semantic: 0.35,
  geometry: 0.35,
  interaction: 0.20,
  mutation: 0.10,
};

export function createDefaultHealthVector(): HealthVector {
  return {
    antiBlockReaction: 0,
    contentAvailability: 1,
    interaction: 1,
    scrollability: 1,
    navigationHealth: 1,
    visualObstruction: 0,
    mutationStability: 1,
    confidence: 1,
  };
}
