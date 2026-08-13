# Background Service Worker Lifecycle

> 47 nodes

## Key Concepts

- **belief.ts** (32 connections) — `src/shared/causal/belief.ts`
- **belief-updater.ts** (31 connections) — `src/background/causal/belief-updater.ts`
- **causal-belief.test.ts** (25 connections) — `tests/unit/causal-belief.test.ts`
- **session-state.ts** (23 connections) — `src/background/causal/session-state.ts`
- **BeliefUpdater** (17 connections) — `src/background/causal/belief-updater.ts`
- **EventGraph** (9 connections) — `src/shared/causal/events.ts`
- **DEFAULT_EXPERIMENT_BUDGET** (5 connections) — `src/shared/causal/graph.ts`
- **.apply()** (4 connections) — `src/background/causal/belief-updater.ts`
- **DEFAULT_SEQUENTIAL_BOUNDS** (4 connections) — `src/shared/causal/belief.ts`
- **observedN()** (4 connections) — `src/shared/causal/belief.ts`
- **successRateCi95()** (4 connections) — `src/shared/causal/belief.ts`
- **.evaluate()** (3 connections) — `src/background/causal/belief-updater.ts`
- **BetaBelief** (3 connections) — `src/shared/causal/belief.ts`
- **WelfordAccumulator** (3 connections) — `src/shared/causal/belief.ts`
- **UNIFORM_PRIOR** (3 connections) — `src/shared/causal/belief.ts`
- **posteriorMean()** (3 connections) — `src/shared/causal/belief.ts`
- **effectFromWelford()** (3 connections) — `src/shared/causal/belief.ts`
- **.decide()** (2 connections) — `src/background/causal/belief-updater.ts`
- **.isConfounded()** (2 connections) — `src/background/causal/belief-updater.ts`
- **.touchEdges()** (2 connections) — `src/background/causal/belief-updater.ts`
- **EffectEstimate** (2 connections) — `src/shared/causal/belief.ts`
- **BeliefDecision** (2 connections) — `src/shared/causal/belief.ts`
- **SequentialBounds** (2 connections) — `src/shared/causal/belief.ts`
- **updateBeta()** (2 connections) — `src/shared/causal/belief.ts`
- **emptyWelford()** (2 connections) — `src/shared/causal/belief.ts`
- *... and 22 more nodes in this community*

## Relationships

- [[End-to-End Test and Verification Suite]] (13 shared connections)
- [[DNR Rule Compiler and Priorities]] (6 shared connections)
- [[Navigation Identity Runtime]] (6 shared connections)
- [[Promotion Test Fixtures]] (6 shared connections)
- [[Temporal Graph Model]] (6 shared connections)
- [[Epoch Session Recovery]] (4 shared connections)
- [[Background Runtime Wiring]] (3 shared connections)
- [[Azure OpenAI Cloud Planner]] (3 shared connections)
- [[Event Graph Storage]] (2 shared connections)
- [[Document Graph Store]] (1 shared connections)
- [[Navigation Epoch Registry]] (1 shared connections)
- [[Candidate Generation and Evidence Builder]] (1 shared connections)

## Source Files

- `src/background/causal/belief-updater.ts`
- `src/background/causal/session-state.ts`
- `src/shared/causal/belief.ts`
- `src/shared/causal/events.ts`
- `src/shared/causal/graph.ts`
- `tests/unit/causal-belief.test.ts`

## Audit Trail

- EXTRACTED: 220 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*