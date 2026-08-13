# Epoch Session Recovery

> 11 nodes

## Key Concepts

- **causal-session-state.test.ts** (16 connections) — `tests/unit/causal-session-state.test.ts`
- **epoch-router.ts** (12 connections) — `src/background/causal/epoch-router.ts`
- **EpochRouter** (8 connections) — `src/background/causal/epoch-router.ts`
- **CausalSessionStateRepository** (7 connections) — `src/background/causal/session-state.ts`
- **.route()** (2 connections) — `src/background/causal/epoch-router.ts`
- **.accept()** (2 connections) — `src/background/causal/epoch-router.ts`
- **RouteDecision** (1 connections) — `src/background/causal/epoch-router.ts`
- **.constructor()** (1 connections) — `src/background/causal/epoch-router.ts`
- **.constructor()** (1 connections) — `src/background/causal/session-state.ts`
- **.restore()** (1 connections) — `src/background/causal/session-state.ts`
- **.persist()** (1 connections) — `src/background/causal/session-state.ts`

## Relationships

- [[End-to-End Test and Verification Suite]] (4 shared connections)
- [[Event Graph Storage]] (4 shared connections)
- [[Navigation Identity Runtime]] (4 shared connections)
- [[Background Service Worker Lifecycle]] (4 shared connections)
- [[Background Runtime Wiring]] (3 shared connections)
- [[Navigation Epoch Registry]] (2 shared connections)
- [[Causal Scope Guards]] (2 shared connections)
- [[Azure OpenAI Cloud Planner]] (2 shared connections)
- [[Experiment Candidate Generation]] (1 shared connections)
- [[Document Graph Store]] (1 shared connections)
- [[Session Storage Test]] (1 shared connections)

## Source Files

- `src/background/causal/epoch-router.ts`
- `src/background/causal/session-state.ts`
- `tests/unit/causal-session-state.test.ts`

## Audit Trail

- EXTRACTED: 52 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*