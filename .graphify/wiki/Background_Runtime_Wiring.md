# Background Runtime Wiring

> 22 nodes

## Key Concepts

- **background.ts** (63 connections) — `src/entrypoints/background.ts`
- **chromeStorageBackend** (1 connections) — `src/entrypoints/background.ts`
- **chromeSessionBackend** (1 connections) — `src/entrypoints/background.ts`
- **chromeDnrBackend** (1 connections) — `src/entrypoints/background.ts`
- **sendTabMessage()** (1 connections) — `src/entrypoints/background.ts`
- **navRegistry** (1 connections) — `src/entrypoints/background.ts`
- **graphManager** (1 connections) — `src/entrypoints/background.ts`
- **requestObserver** (1 connections) — `src/entrypoints/background.ts`
- **dnrController** (1 connections) — `src/entrypoints/background.ts`
- **recipeStore** (1 connections) — `src/entrypoints/background.ts`
- **auditStore** (1 connections) — `src/entrypoints/background.ts`
- **adaptEngine** (1 connections) — `src/entrypoints/background.ts`
- **causalResources** (1 connections) — `src/entrypoints/background.ts`
- **causalGraphs** (1 connections) — `src/entrypoints/background.ts`
- **beliefUpdater** (1 connections) — `src/entrypoints/background.ts`
- **causalSession** (1 connections) — `src/entrypoints/background.ts`
- **causalRecipeStore** (1 connections) — `src/entrypoints/background.ts`
- **promotionGate** (1 connections) — `src/entrypoints/background.ts`
- **causalEngine** (1 connections) — `src/entrypoints/background.ts`
- **causalOrchestrator** (1 connections) — `src/entrypoints/background.ts`
- **startupReady** (1 connections) — `src/entrypoints/background.ts`
- **causalQueues** (1 connections) — `src/entrypoints/background.ts`

## Relationships

- [[Navigation Identity Runtime]] (5 shared connections)
- [[Azure OpenAI Cloud Planner]] (5 shared connections)
- [[Background Service Worker Lifecycle]] (3 shared connections)
- [[AI Planning and Oracle Server]] (3 shared connections)
- [[Epoch Session Recovery]] (3 shared connections)
- [[Chromium Verification Suites]] (3 shared connections)
- [[Candidate Generation and Evidence Builder]] (2 shared connections)
- [[Causal Runtime Orchestration]] (2 shared connections)
- [[Network Request Telemetry]] (2 shared connections)
- [[DNR Rule ID Allocation]] (2 shared connections)
- [[Promoção de Receitas]] (1 shared connections)
- [[Adaptation Transaction Health]] (1 shared connections)

## Source Files

- `src/entrypoints/background.ts`

## Audit Trail

- EXTRACTED: 84 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*