import { EvidencePacket, AdaptationPlan } from './types';

export interface AdaptivePlanner {
  plan(evidence: EvidencePacket): Promise<AdaptationPlan>;
}
