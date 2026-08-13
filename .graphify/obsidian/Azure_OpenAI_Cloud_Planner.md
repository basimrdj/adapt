# Azure OpenAI Cloud Planner

> 25 nodes

## Key Concepts

- **store.ts** (21 connections) — `src/core/recipes/store.ts`
- **DnrController** (18 connections) — `src/core/dnr/controller.ts`
- **concurrency-stress.test.ts** (17 connections) — `tests/unit/concurrency-stress.test.ts`
- **store.ts** (16 connections) — `src/core/audit/store.ts`
- **ai-stale-response-concurrency.test.ts** (14 connections) — `tests/unit/ai-stale-response-concurrency.test.ts`
- **AuditStore** (13 connections) — `src/core/audit/store.ts`
- **adaptation-engine.test.ts** (13 connections) — `tests/unit/adaptation-engine.test.ts`
- **ai-recipe-learning-baseline.test.ts** (13 connections) — `tests/unit/ai-recipe-learning-baseline.test.ts`
- **PageSignalBatch** (12 connections) — `src/shared/types.ts`
- **StorageBackend** (10 connections) — `src/core/recipes/store.ts`
- **STORAGE_KEYS** (9 connections) — `src/shared/constants.ts`
- **chrome-storage.ts** (5 connections) — `src/background/storage/chrome-storage.ts`
- **.ensureInitialized()** (3 connections) — `src/core/audit/store.ts`
- **.recordEvent()** (2 connections) — `src/core/audit/store.ts`
- **.getRecentEvents()** (2 connections) — `src/core/audit/store.ts`
- **.constructor()** (1 connections) — `src/core/audit/store.ts`
- **.clearLogs()** (1 connections) — `src/core/audit/store.ts`
- **.constructor()** (1 connections) — `src/core/dnr/controller.ts`
- **.addSessionExperimentRules()** (1 connections) — `src/core/dnr/controller.ts`
- **.removeSessionExperimentRules()** (1 connections) — `src/core/dnr/controller.ts`
- **.persistLearnedRules()** (1 connections) — `src/core/dnr/controller.ts`
- **.removeDynamicLearnedRules()** (1 connections) — `src/core/dnr/controller.ts`
- **.reconcile()** (1 connections) — `src/core/dnr/controller.ts`
- **.getAllAllocations()** (1 connections) — `src/core/dnr/controller.ts`
- **.getQuotaTracker()** (1 connections) — `src/core/dnr/controller.ts`

## Relationships

- [[Candidate Generation and Evidence Builder]] (17 shared connections)
- [[Adaptation Transaction Health]] (16 shared connections)
- [[AI Planning and Oracle Server]] (14 shared connections)
- [[DNR Rule ID Allocation]] (9 shared connections)
- [[Transaction Health and Rollback]] (8 shared connections)
- [[Background Runtime Wiring]] (5 shared connections)
- [[Adaptation Engine Lifecycle]] (4 shared connections)
- [[Promoção de Receitas]] (3 shared connections)
- [[DNR Rule Compiler and Priorities]] (3 shared connections)
- [[Background Service Worker Lifecycle]] (3 shared connections)
- [[Promotion Test Fixtures]] (3 shared connections)
- [[Navigation Identity Runtime]] (2 shared connections)

## Source Files

- `src/background/storage/chrome-storage.ts`
- `src/core/audit/store.ts`
- `src/core/dnr/controller.ts`
- `src/core/recipes/store.ts`
- `src/shared/constants.ts`
- `src/shared/types.ts`
- `tests/unit/adaptation-engine.test.ts`
- `tests/unit/ai-recipe-learning-baseline.test.ts`
- `tests/unit/ai-stale-response-concurrency.test.ts`
- `tests/unit/concurrency-stress.test.ts`

## Audit Trail

- EXTRACTED: 178 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*