# Causal Runtime Orchestration

> 20 nodes

## Key Concepts

- **CausalOrchestrator** (15 connections) — `src/background/causal/orchestrator.ts`
- **.onPageObservation()** (7 connections) — `src/background/causal/orchestrator.ts`
- **CausalResourceRegistry** (5 connections) — `src/background/causal/orchestrator.ts`
- **.onHealthSnapshot()** (4 connections) — `src/background/causal/orchestrator.ts`
- **.maybeReplay()** (4 connections) — `src/background/causal/orchestrator.ts`
- **.finishReplay()** (4 connections) — `src/background/causal/orchestrator.ts`
- **.enrichHealth()** (3 connections) — `src/background/causal/orchestrator.ts`
- **.fingerprint()** (3 connections) — `src/background/causal/orchestrator.ts`
- **.maybeDraftOrPromote()** (3 connections) — `src/background/causal/orchestrator.ts`
- **compactScore()** (2 connections) — `src/background/causal/orchestrator.ts`
- **nowNode()** (2 connections) — `src/background/causal/orchestrator.ts`
- **.observe()** (2 connections) — `src/background/causal/orchestrator.ts`
- **.onRequest()** (2 connections) — `src/background/causal/orchestrator.ts`
- **.maybeRun()** (2 connections) — `src/background/causal/orchestrator.ts`
- **.remapActions()** (2 connections) — `src/background/causal/orchestrator.ts`
- **.toCompact()** (2 connections) — `src/background/causal/orchestrator.ts`
- **StrategyResolutionContext** (1 connections)
- **.resolveRequest()** (1 connections) — `src/background/causal/orchestrator.ts`
- **.constructor()** (1 connections) — `src/background/causal/orchestrator.ts`
- **.onNavigation()** (1 connections) — `src/background/causal/orchestrator.ts`

## Relationships

- [[End-to-End Test and Verification Suite]] (4 shared connections)
- [[Background Runtime Wiring]] (2 shared connections)

## Source Files

- `src/background/causal/orchestrator.ts`

## Audit Trail

- EXTRACTED: 66 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*