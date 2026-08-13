# Causal Recipe Storage

> 11 nodes

## Key Concepts

- **CausalRecipeStore** (14 connections) — `src/background/causal/promotion-gate.ts`
- **.init()** (6 connections) — `src/background/causal/promotion-gate.ts`
- **.save()** (3 connections) — `src/background/causal/promotion-gate.ts`
- **.delete()** (3 connections) — `src/background/causal/promotion-gate.ts`
- **.persist()** (3 connections) — `src/background/causal/promotion-gate.ts`
- **.allocateId()** (2 connections) — `src/background/causal/promotion-gate.ts`
- **.getRecipe()** (2 connections) — `src/background/causal/promotion-gate.ts`
- **.getByOriginHash()** (2 connections) — `src/background/causal/promotion-gate.ts`
- **.getAll()** (2 connections) — `src/background/causal/promotion-gate.ts`
- **.constructor()** (1 connections) — `src/background/causal/promotion-gate.ts`
- **.peekNextSeq()** (1 connections) — `src/background/causal/promotion-gate.ts`

## Relationships

- [[End-to-End Test and Verification Suite]] (1 shared connections)
- [[DNR Rule Compiler and Priorities]] (1 shared connections)
- [[Background Runtime Wiring]] (1 shared connections)
- [[Promotion Test Fixtures]] (1 shared connections)
- [[Recipe Promotion Gates]] (1 shared connections)

## Source Files

- `src/background/causal/promotion-gate.ts`

## Audit Trail

- EXTRACTED: 39 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*