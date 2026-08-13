# Event Graph Storage

> 20 nodes

## Key Concepts

- **causal-eventgraph.test.ts** (33 connections) — `tests/unit/causal-eventgraph.test.ts`
- **graph-store.ts** (25 connections) — `src/background/causal/graph-store.ts`
- **CausalDocumentKey** (9 connections) — `src/shared/causal/events.ts`
- **causalKeyFromNode()** (5 connections) — `src/shared/causal/events.ts`
- **addNode()** (4 connections) — `src/shared/causal/graph.ts`
- **pruneGraph()** (3 connections) — `src/shared/causal/graph.ts`
- **GraphRejectReason** (2 connections) — `src/shared/causal/graph.ts`
- **serializeCausalKey()** (2 connections) — `src/shared/causal/graph.ts`
- **GraphAppendReason** (1 connections) — `src/background/causal/graph-store.ts`
- **GraphAppendResult** (1 connections) — `src/background/causal/graph-store.ts`
- **GraphSlot** (1 connections) — `src/background/causal/graph-store.ts`
- **FIXTURE_DIR** (1 connections) — `tests/unit/causal-eventgraph.test.ts`
- **GroundTruthPair** (1 connections) — `tests/unit/causal-eventgraph.test.ts`
- **CausalFixture** (1 connections) — `tests/unit/causal-eventgraph.test.ts`
- **loadFixture()** (1 connections) — `tests/unit/causal-eventgraph.test.ts`
- **isNoneTruth()** (1 connections) — `tests/unit/causal-eventgraph.test.ts`
- **makeNode()** (1 connections) — `tests/unit/causal-eventgraph.test.ts`
- **replay()** (1 connections) — `tests/unit/causal-eventgraph.test.ts`
- **recallsPair()** (1 connections) — `tests/unit/causal-eventgraph.test.ts`
- **ANTI_BLOCK_FIXTURES** (1 connections) — `tests/unit/causal-eventgraph.test.ts`

## Relationships

- [[Temporal Graph Model]] (16 shared connections)
- [[End-to-End Test and Verification Suite]] (11 shared connections)
- [[Epoch Session Recovery]] (4 shared connections)
- [[AI Planning and Oracle Server]] (3 shared connections)
- [[Navigation Identity Runtime]] (3 shared connections)
- [[Content Script Page Sensor]] (3 shared connections)
- [[Background Service Worker Lifecycle]] (2 shared connections)
- [[Experiment Candidate Generation]] (2 shared connections)
- [[Document Graph Store]] (2 shared connections)
- [[DOM Mutation Governor Pipeline]] (2 shared connections)
- [[Background Runtime Wiring]] (1 shared connections)

## Source Files

- `src/background/causal/graph-store.ts`
- `src/shared/causal/events.ts`
- `src/shared/causal/graph.ts`
- `tests/unit/causal-eventgraph.test.ts`

## Audit Trail

- EXTRACTED: 95 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*