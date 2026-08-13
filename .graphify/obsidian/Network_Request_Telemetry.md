# Network Request Telemetry

> 14 nodes

## Key Concepts

- **request-graph.ts** (10 connections) — `src/core/network/request-graph.ts`
- **RequestGraphManager** (10 connections) — `src/core/network/request-graph.ts`
- **normalize-url.ts** (7 connections) — `src/core/network/normalize-url.ts`
- **normalizeUrlForTelemetry()** (5 connections) — `src/core/network/normalize-url.ts`
- **.getOrCreateGraph()** (3 connections) — `src/core/network/request-graph.ts`
- **url-normalizer.test.ts** (3 connections) — `tests/unit/url-normalizer.test.ts`
- **.recordRequest()** (2 connections) — `src/core/network/request-graph.ts`
- **.recordBlockedOrError()** (2 connections) — `src/core/network/request-graph.ts`
- **NormalizedUrl** (1 connections) — `src/core/network/normalize-url.ts`
- **RequestRecord** (1 connections) — `src/core/network/request-graph.ts`
- **NavigationRequestGraph** (1 connections) — `src/core/network/request-graph.ts`
- **.recordCompleted()** (1 connections) — `src/core/network/request-graph.ts`
- **.cleanupGraph()** (1 connections) — `src/core/network/request-graph.ts`
- **.getGraph()** (1 connections) — `src/core/network/request-graph.ts`

## Relationships

- [[End-to-End Test and Verification Suite]] (6 shared connections)
- [[Candidate Generation and Evidence Builder]] (3 shared connections)
- [[Navigation Identity Runtime]] (3 shared connections)
- [[Background Runtime Wiring]] (2 shared connections)

## Source Files

- `src/core/network/normalize-url.ts`
- `src/core/network/request-graph.ts`
- `tests/unit/url-normalizer.test.ts`

## Audit Trail

- EXTRACTED: 48 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*