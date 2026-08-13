# Navigation Epoch Registry

> 12 nodes

## Key Concepts

- **NavigationRegistry** (23 connections) — `src/core/navigation/registry.ts`
- **.nextNavigationEpoch()** (3 connections) — `src/core/navigation/registry.ts`
- **.getEpoch()** (3 connections) — `src/core/navigation/registry.ts`
- **.getCausalKey()** (3 connections) — `src/core/navigation/registry.ts`
- **.onNavigationCommitted()** (2 connections) — `src/core/navigation/registry.ts`
- **.onHistoryStateUpdated()** (2 connections) — `src/core/navigation/registry.ts`
- **.isEpochValid()** (2 connections) — `src/core/navigation/registry.ts`
- **.isCausalScopeValid()** (2 connections) — `src/core/navigation/registry.ts`
- **.onTabClosed()** (1 connections) — `src/core/navigation/registry.ts`
- **.getActiveTabIds()** (1 connections) — `src/core/navigation/registry.ts`
- **.snapshot()** (1 connections) — `src/core/navigation/registry.ts`
- **.hydrate()** (1 connections) — `src/core/navigation/registry.ts`

## Relationships

- [[Navigation Identity Runtime]] (3 shared connections)
- [[AI Planning and Oracle Server]] (2 shared connections)
- [[Epoch Session Recovery]] (2 shared connections)
- [[End-to-End Test and Verification Suite]] (2 shared connections)
- [[Background Service Worker Lifecycle]] (1 shared connections)
- [[Background Runtime Wiring]] (1 shared connections)
- [[Causal Scope Guards]] (1 shared connections)

## Source Files

- `src/core/navigation/registry.ts`

## Audit Trail

- EXTRACTED: 44 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*