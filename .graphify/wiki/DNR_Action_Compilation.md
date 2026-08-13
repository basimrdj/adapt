# DNR Action Compilation

> 12 nodes

## Key Concepts

- **compiler.ts** (13 connections) — `src/core/dnr/compiler.ts`
- **dnr-compiler.test.ts** (9 connections) — `tests/unit/dnr-compiler.test.ts`
- **priorities.ts** (6 connections) — `src/core/dnr/priorities.ts`
- **BaseAction** (6 connections) — `src/shared/types.ts`
- **NetBlockAction** (4 connections) — `src/shared/types.ts`
- **NetAllowAction** (4 connections) — `src/shared/types.ts`
- **NetRedirectAction** (4 connections) — `src/shared/types.ts`
- **PRIORITIES** (3 connections) — `src/shared/constants.ts`
- **RuntimeOpAction** (3 connections) — `src/shared/types.ts`
- **PriorityBand** (2 connections) — `src/core/dnr/priorities.ts`
- **getPriority()** (2 connections) — `src/core/dnr/priorities.ts`
- **CompiledDnrRule** (1 connections) — `src/core/dnr/compiler.ts`

## Relationships

- [[DNR Rule ID Allocation]] (9 shared connections)
- [[Candidate Generation and Evidence Builder]] (7 shared connections)
- [[DNR Compiler]] (2 shared connections)
- [[Promotion Test Fixtures]] (1 shared connections)

## Source Files

- `src/core/dnr/compiler.ts`
- `src/core/dnr/priorities.ts`
- `src/shared/constants.ts`
- `src/shared/types.ts`
- `tests/unit/dnr-compiler.test.ts`

## Audit Trail

- EXTRACTED: 57 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*