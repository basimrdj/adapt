# Adaptation Transaction Health

> 20 nodes

## Key Concepts

- **engine.ts** (46 connections) — `src/core/adaptation/engine.ts`
- **HealthVector** (18 connections) — `src/shared/types.ts`
- **rollback.ts** (11 connections) — `src/core/adaptation/rollback.ts`
- **compare.ts** (11 connections) — `src/core/health/compare.ts`
- **StrategyCandidate** (11 connections) — `src/shared/types.ts`
- **transaction.ts** (10 connections) — `src/core/adaptation/transaction.ts`
- **verify.ts** (10 connections) — `src/core/adaptation/verify.ts`
- **candidates.ts** (7 connections) — `src/core/adaptation/candidates.ts`
- **AdaptationTransaction** (7 connections) — `src/shared/types.ts`
- **health-compare.test.ts** (5 connections) — `tests/unit/health-compare.test.ts`
- **AdaptationVerifier** (4 connections) — `src/core/adaptation/verify.ts`
- **verifyHealthOutcome()** (4 connections) — `src/core/health/compare.ts`
- **VerificationResult** (4 connections) — `src/shared/types.ts`
- **StrategyCandidateGenerator** (3 connections) — `src/core/adaptation/candidates.ts`
- **createAdaptationTransaction()** (2 connections) — `src/core/adaptation/transaction.ts`
- **updateTransactionState()** (2 connections) — `src/core/adaptation/transaction.ts`
- **TransactionState** (2 connections) — `src/shared/types.ts`
- **.generateCandidates()** (1 connections) — `src/core/adaptation/candidates.ts`
- **NavigationFreshnessGuard** (1 connections) — `src/core/adaptation/engine.ts`
- **.evaluate()** (1 connections) — `src/core/adaptation/verify.ts`

## Relationships

- [[Azure OpenAI Cloud Planner]] (16 shared connections)
- [[AI Planning and Oracle Server]] (16 shared connections)
- [[DNR Rule ID Allocation]] (14 shared connections)
- [[Candidate Generation and Evidence Builder]] (12 shared connections)
- [[Transaction Health and Rollback]] (11 shared connections)
- [[Health Vector Scoring]] (4 shared connections)
- [[Promoção de Receitas]] (3 shared connections)
- [[Navigation Identity Runtime]] (3 shared connections)
- [[End-to-End Test and Verification Suite]] (3 shared connections)
- [[Chromium Verification Suites]] (2 shared connections)
- [[Adaptation Engine Lifecycle]] (1 shared connections)
- [[Background Runtime Wiring]] (1 shared connections)

## Source Files

- `src/core/adaptation/candidates.ts`
- `src/core/adaptation/engine.ts`
- `src/core/adaptation/rollback.ts`
- `src/core/adaptation/transaction.ts`
- `src/core/adaptation/verify.ts`
- `src/core/health/compare.ts`
- `src/shared/types.ts`
- `tests/unit/health-compare.test.ts`

## Audit Trail

- EXTRACTED: 160 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*