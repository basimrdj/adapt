# End-to-End Test and Verification Suite

> 33 nodes

## Key Concepts

- **orchestrator.ts** (61 connections) — `src/background/causal/orchestrator.ts`
- **events.ts** (47 connections) — `src/shared/causal/events.ts`
- **event-normalizer.ts** (26 connections) — `src/background/causal/event-normalizer.ts`
- **OpaqueRef** (12 connections) — `src/shared/causal/events.ts`
- **CausalHypothesis** (11 connections) — `src/shared/causal/events.ts`
- **hashOrigin()** (9 connections) — `src/shared/causal/events.ts`
- **EventNormalizer** (6 connections) — `src/background/causal/event-normalizer.ts`
- **HealthVectorCompact** (6 connections) — `src/shared/causal/events.ts`
- **CandidateGenerator** (5 connections) — `src/background/causal/candidate-generator.ts`
- **.normalizeRequest()** (5 connections) — `src/background/causal/event-normalizer.ts`
- **EventKind** (5 connections) — `src/shared/causal/events.ts`
- **.normalizeNavigation()** (4 connections) — `src/background/causal/event-normalizer.ts`
- **timestampFromChrome()** (3 connections) — `src/background/causal/event-normalizer.ts`
- **stablePositiveIntFromRequestId()** (3 connections) — `src/background/causal/event-normalizer.ts`
- **requestRef()** (3 connections) — `src/background/causal/event-normalizer.ts`
- **coarseUrlFeatures()** (3 connections) — `src/background/causal/event-normalizer.ts`
- **EventProvenance** (3 connections) — `src/shared/causal/events.ts`
- **ExperimentBudget** (3 connections) — `src/shared/causal/events.ts`
- **createEventId()** (3 connections) — `src/shared/causal/events.ts`
- **clampConfidence()** (3 connections) — `src/shared/causal/events.ts`
- **sha256HexUtf8()** (3 connections) — `src/shared/causal/events.ts`
- **RawNavigationEvent** (2 connections) — `src/background/causal/event-normalizer.ts`
- **RawRequestEvent** (2 connections) — `src/background/causal/event-normalizer.ts`
- **navigationKind()** (2 connections) — `src/background/causal/event-normalizer.ts`
- **requestKind()** (2 connections) — `src/background/causal/event-normalizer.ts`
- *... and 8 more nodes in this community*

## Relationships

- [[Background Service Worker Lifecycle]] (13 shared connections)
- [[Event Graph Storage]] (11 shared connections)
- [[AI Planning and Oracle Server]] (10 shared connections)
- [[Content Script Page Sensor]] (9 shared connections)
- [[DNR Rule Compiler and Priorities]] (9 shared connections)
- [[Experiment Candidate Generation]] (8 shared connections)
- [[Navigation Identity Runtime]] (8 shared connections)
- [[Promotion Test Fixtures]] (8 shared connections)
- [[Causal Scope Guards]] (7 shared connections)
- [[Adaptation Engine Lifecycle and Recovery]] (7 shared connections)
- [[DOM Mutation Governor Pipeline]] (6 shared connections)
- [[Network Request Telemetry]] (6 shared connections)

## Source Files

- `src/background/causal/candidate-generator.ts`
- `src/background/causal/event-normalizer.ts`
- `src/background/causal/orchestrator.ts`
- `src/shared/causal/events.ts`

## Audit Trail

- EXTRACTED: 242 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*