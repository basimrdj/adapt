# DNR Rule Compiler and Priorities

> 27 nodes

## Key Concepts

- **promotion-gate.ts** (53 connections) — `src/background/causal/promotion-gate.ts`
- **recipes.ts** (31 connections) — `src/shared/causal/recipes.ts`
- **ExperimentRecord** (8 connections) — `src/shared/causal/events.ts`
- **fingerprintEvidenceHash()** (5 connections) — `src/shared/causal/recipes.ts`
- **checkFingerprint()** (4 connections) — `src/shared/causal/recipes.ts`
- **CausalRecipe** (3 connections) — `src/shared/causal/recipes.ts`
- **pathClassMatches()** (3 connections) — `src/shared/causal/recipes.ts`
- **lastExperiment()** (2 connections) — `src/background/causal/promotion-gate.ts`
- **CausalRecipeLifecycle** (2 connections) — `src/shared/causal/recipes.ts`
- **CausalRecipeRecord** (2 connections) — `src/shared/causal/recipes.ts`
- **CAUSAL_RECIPE_VERSION** (2 connections) — `src/shared/causal/recipes.ts`
- **PROMOTION_GATES** (2 connections) — `src/shared/causal/recipes.ts`
- **PromotionGateName** (2 connections) — `src/shared/causal/recipes.ts`
- **isIdentityMismatch()** (2 connections) — `src/shared/causal/recipes.ts`
- **recipeId()** (2 connections) — `src/shared/causal/recipes.ts`
- **hashTechnicalTokens()** (2 connections) — `src/shared/causal/recipes.ts`
- **replayHealthOk()** (2 connections) — `src/shared/causal/recipes.ts`
- **cloneRecipe()** (2 connections) — `src/shared/causal/recipes.ts`
- **REVERSIBLE_ACTION_TYPES** (1 connections) — `src/background/causal/promotion-gate.ts`
- **PromotionEvaluateResult** (1 connections) — `src/background/causal/promotion-gate.ts`
- **PromotionReplayResult** (1 connections) — `src/background/causal/promotion-gate.ts`
- **StoredBundle** (1 connections) — `src/background/causal/promotion-gate.ts`
- **allPromotionGates()** (1 connections) — `src/background/causal/promotion-gate.ts`
- **FingerprintCheckKind** (1 connections) — `src/shared/causal/recipes.ts`
- **FingerprintCheck** (1 connections) — `src/shared/causal/recipes.ts`
- *... and 2 more nodes in this community*

## Relationships

- [[Promotion Test Fixtures]] (15 shared connections)
- [[End-to-End Test and Verification Suite]] (9 shared connections)
- [[Background Service Worker Lifecycle]] (6 shared connections)
- [[Recipe Promotion Gates]] (6 shared connections)
- [[Promotion Safety Filters]] (4 shared connections)
- [[Azure OpenAI Cloud Planner]] (3 shared connections)
- [[DNR Rule ID Allocation]] (3 shared connections)
- [[AI Planning and Oracle Server]] (2 shared connections)
- [[Adaptation Engine Lifecycle and Recovery]] (2 shared connections)
- [[Navigation Identity Runtime]] (2 shared connections)
- [[Causal Recipe Storage]] (1 shared connections)
- [[Candidate Generation and Evidence Builder]] (1 shared connections)

## Source Files

- `src/background/causal/promotion-gate.ts`
- `src/shared/causal/events.ts`
- `src/shared/causal/recipes.ts`

## Audit Trail

- EXTRACTED: 138 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*