# Session Storage Test

> 5 nodes

## Key Concepts

- **MemorySessionStorage** (5 connections) — `tests/unit/causal-session-state.test.ts`
- **StorageBackend** (1 connections)
- **.get()** (1 connections) — `tests/unit/causal-session-state.test.ts`
- **.set()** (1 connections) — `tests/unit/causal-session-state.test.ts`
- **.remove()** (1 connections) — `tests/unit/causal-session-state.test.ts`

## Relationships

- [[Epoch Session Recovery]] (1 shared connections)

## Source Files

- `tests/unit/causal-session-state.test.ts`

## Audit Trail

- EXTRACTED: 9 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*