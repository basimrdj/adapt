# Experiment Candidate Generation

> 15 nodes

## Key Concepts

- **experiment-generator.ts** (27 connections) — `src/background/causal/experiment-generator.ts`
- **EventNode** (10 connections) — `src/shared/causal/events.ts`
- **.generate()** (6 connections) — `src/background/causal/experiment-generator.ts`
- **ExperimentGenerator** (4 connections) — `src/background/causal/experiment-generator.ts`
- **hypothesisTouchesBenign()** (3 connections) — `src/background/causal/experiment-generator.ts`
- **graphIsBenignOnly()** (2 connections) — `src/background/causal/experiment-generator.ts`
- **nodeById()** (2 connections) — `src/background/causal/experiment-generator.ts`
- **collectActionRefs()** (2 connections) — `src/background/causal/experiment-generator.ts`
- **scopeFromGraph()** (2 connections) — `src/background/causal/experiment-generator.ts`
- **pairedBaselineAvailable()** (2 connections) — `src/background/causal/experiment-generator.ts`
- **MECHANISM_INTERVENTION_TEMPLATES** (2 connections) — `src/shared/causal/experiments.ts`
- **withinBudgetCeilings()** (2 connections) — `src/shared/causal/experiments.ts`
- **uniqueOpaqueRefs()** (2 connections) — `src/shared/causal/experiments.ts`
- **nextExperimentId()** (2 connections) — `src/shared/causal/experiments.ts`
- **SKIPPED_MECHANISMS** (1 connections) — `src/background/causal/experiment-generator.ts`

## Relationships

- [[End-to-End Test and Verification Suite]] (8 shared connections)
- [[Adaptation Engine Lifecycle and Recovery]] (8 shared connections)
- [[Content Script Page Sensor]] (4 shared connections)
- [[Temporal Graph Model]] (3 shared connections)
- [[Event Graph Storage]] (2 shared connections)
- [[Background Service Worker Lifecycle]] (1 shared connections)
- [[Navigation Identity Runtime]] (1 shared connections)
- [[DOM Mutation Governor Pipeline]] (1 shared connections)
- [[Epoch Session Recovery]] (1 shared connections)

## Source Files

- `src/background/causal/experiment-generator.ts`
- `src/shared/causal/events.ts`
- `src/shared/causal/experiments.ts`

## Audit Trail

- EXTRACTED: 69 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*