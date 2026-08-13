# Adaptation Engine Lifecycle

> 11 nodes

## Key Concepts

- **AdaptationTransactionEngine** (18 connections) — `src/core/adaptation/engine.ts`
- **.init()** (5 connections) — `src/core/adaptation/engine.ts`
- **.persistActiveTransactions()** (5 connections) — `src/core/adaptation/engine.ts`
- **.stageTransaction()** (5 connections) — `src/core/adaptation/engine.ts`
- **.evaluateSignals()** (4 connections) — `src/core/adaptation/engine.ts`
- **.verifyAndCompleteTransaction()** (3 connections) — `src/core/adaptation/engine.ts`
- **.rollbackAllOrphaned()** (3 connections) — `src/core/adaptation/engine.ts`
- **.navigationIsCurrent()** (3 connections) — `src/core/adaptation/engine.ts`
- **.releaseTransaction()** (2 connections) — `src/core/adaptation/engine.ts`
- **.constructor()** (1 connections) — `src/core/adaptation/engine.ts`
- **.getActiveTransactions()** (1 connections) — `src/core/adaptation/engine.ts`

## Relationships

- [[Azure OpenAI Cloud Planner]] (4 shared connections)
- [[AI Planning and Oracle Server]] (2 shared connections)
- [[Adaptation Transaction Health]] (1 shared connections)
- [[Background Runtime Wiring]] (1 shared connections)

## Source Files

- `src/core/adaptation/engine.ts`

## Audit Trail

- EXTRACTED: 50 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*