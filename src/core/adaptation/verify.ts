import { AdaptationTransaction, HealthVector, VerificationResult } from '../../shared/types';
import { verifyHealthOutcome } from '../health/compare';

export class AdaptationVerifier {
  public evaluate(tx: AdaptationTransaction, currentHealth: HealthVector): VerificationResult {
    return verifyHealthOutcome(tx.baselineHealth, currentHealth);
  }
}
