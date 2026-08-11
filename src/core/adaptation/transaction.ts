import {
  AdaptationTransaction,
  StrategyCandidate,
  HealthVector,
  TransactionState,
  VerificationResult,
} from '../../shared/types';

export function createAdaptationTransaction(
  tabId: number,
  navigationId: string,
  siteKey: string,
  baselineHealth: HealthVector,
  candidate: StrategyCandidate
): AdaptationTransaction {
  const now = Date.now();
  return {
    txId: `tx_${tabId}_${now}_${Math.random().toString(36).substring(2, 7)}`,
    tabId,
    navigationId,
    siteKey,
    createdAt: now,
    updatedAt: now,
    baselineHealth,
    candidate,
    sessionRuleIds: [],
    domActionIds: [],
    state: 'candidate',
  };
}

export function updateTransactionState(
  tx: AdaptationTransaction,
  nextState: TransactionState,
  verification?: VerificationResult
): AdaptationTransaction {
  return {
    ...tx,
    state: nextState,
    updatedAt: Date.now(),
    verification: verification || tx.verification,
  };
}
