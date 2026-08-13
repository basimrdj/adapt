# AI Planning and Oracle Server

> 61 nodes

## Key Concepts

- **causal-engine.ts** (50 connections) — `src/background/causal/causal-engine.ts`
- **causal-engine.test.ts** (42 connections) — `tests/unit/causal-engine.test.ts`
- **experiment-to-strategy.ts** (22 connections) — `src/background/causal/experiment-to-strategy.ts`
- **CausalEngine** (16 connections) — `src/background/causal/causal-engine.ts`
- **RecipeStore** (15 connections) — `src/core/recipes/store.ts`
- **.verifyCausalExperiment()** (10 connections) — `src/background/causal/causal-engine.ts`
- **.runCausalExperiment()** (9 connections) — `src/background/causal/causal-engine.ts`
- **.rollbackState()** (6 connections) — `src/background/causal/causal-engine.ts`
- **experimentToStrategy()** (6 connections) — `src/background/causal/experiment-to-strategy.ts`
- **AdaptationRollbackHandler** (6 connections) — `src/core/adaptation/rollback.ts`
- **MemoryStorage** (6 connections) — `tests/unit/causal-engine.test.ts`
- **.init()** (5 connections) — `src/background/causal/causal-engine.ts`
- **.init()** (5 connections) — `src/core/recipes/store.ts`
- **toAdaptationTx()** (4 connections) — `src/background/causal/causal-engine.ts`
- **.onNavigation()** (4 connections) — `src/background/causal/causal-engine.ts`
- **.persistRecords()** (4 connections) — `src/background/causal/causal-engine.ts`
- **toCompact()** (3 connections) — `src/background/causal/causal-engine.ts`
- **liveEpoch()** (3 connections) — `src/background/causal/causal-engine.ts`
- **primaryFrameId()** (3 connections) — `src/background/causal/causal-engine.ts`
- **makeRecord()** (3 connections) — `src/background/causal/causal-engine.ts`
- **.cleanupCommittedState()** (3 connections) — `src/background/causal/causal-engine.ts`
- **StrategyResolutionContext** (3 connections) — `src/background/causal/experiment-to-strategy.ts`
- **.saveRecipe()** (3 connections) — `src/core/recipes/store.ts`
- **.deleteRecipe()** (3 connections) — `src/core/recipes/store.ts`
- **.persist()** (3 connections) — `src/core/recipes/store.ts`
- *... and 36 more nodes in this community*

## Relationships

- [[Adaptation Transaction Health]] (16 shared connections)
- [[Azure OpenAI Cloud Planner]] (14 shared connections)
- [[End-to-End Test and Verification Suite]] (10 shared connections)
- [[Adaptation Engine Lifecycle and Recovery]] (7 shared connections)
- [[Content Script Page Sensor]] (7 shared connections)
- [[Candidate Generation and Evidence Builder]] (5 shared connections)
- [[Navigation Identity Runtime]] (5 shared connections)
- [[DNR Rule ID Allocation]] (4 shared connections)
- [[Event Graph Storage]] (3 shared connections)
- [[Promotion Test Fixtures]] (3 shared connections)
- [[Background Runtime Wiring]] (3 shared connections)
- [[Adaptation Engine Lifecycle]] (2 shared connections)

## Source Files

- `src/background/causal/causal-engine.ts`
- `src/background/causal/experiment-to-strategy.ts`
- `src/core/adaptation/rollback.ts`
- `src/core/recipes/store.ts`
- `src/shared/causal/experiments.ts`
- `src/shared/types.ts`
- `tests/unit/causal-engine.test.ts`

## Audit Trail

- EXTRACTED: 289 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*