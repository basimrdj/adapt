# Phase 3 Gap Analysis — Spec vs Actual Codebase

> Bridges the Phase 3 spec's assumptions against verified Phase 1-2.5 reality.
> Generated 2026-08-12 from full source/docs/test/graphify audit.

## What the Phase 3 spec ASSUMES (Section 1, "inherits and MUST NOT break")
1. AI remains advisory, opaque refs, PolicyValidator authoritative ✅ (architecture intact)
2. Transactions reversible, epoch-fresh, tab-isolated ✅ (verified)
3. **"Known recipes remain the fast path — confirmed recipe replays with zero AI"** ⚠️
   → recipes are saved but `RecipePromotionManager` is orphaned; nothing reaches
   `confirmed`; `persistLearnedRules` never promotes a recipe into DNR dynamic rules.
   Phase 3's `CausalRecipe` model supersedes this, but the *promotion gate* and
   *recipe store* must actually work for Phase 3's value prop (visit 2 = 0 AI).
4. SW-death survivable ✅ (Phase 1.5 verified)
5. No cloud dep in production ✅ (verified)

## Phase 3 building blocks that DON'T exist yet (greenfield)
- EventGraph (events.ts, graph.ts) — entirely new
- Causal hypothesis store + candidate generator — new
- Experiment model (candidate/record) + selector — new
- Bayesian/sequential belief updater (Beta-Bernoulli, effect estimates) — new
- Phase 3 PolicyValidator additions (`validateCausalDecision`) — new
- Health Vector v3 (8-dim compact, privacy floor) — extends current 7-dim
- CausalRecipe + promotion gate (safety/statistical/replay/privacy/fingerprint/rollback)
- Page fingerprint + non-stationarity decay
- Clock-domain model — new
- Offline causal-lab (tools/causal-lab/, PC/GES/FCI via causal-learn) — new
- Synthetic causal fixture corpus (12 mechanism families) — new

## Phase 3 building blocks that PARTIALLY exist (extend, don't rebuild)
- Navigation epoch registry → needs `documentId` added to the causal key
  (spec key = `tabId + navigationEpoch + documentId + frameId`); current uses
  navigationId only. Must verify `webNavigation` documentId availability (M0).
- webRequest observer → exists but request-graph output is unused; Phase 3
  needs it as provenance-tagged event source.
- Mutation pipeline → exists with 4-stage governor; Phase 3 needs bounded
  semantic event extraction (overlay_appeared, scroll_lock_on, etc.).
- Health scorer → exists (7-dim); Phase 3 wants 8-dim compact + privacy floor.
- Transaction engine → exists; Phase 3 adds `runCausalExperiment` path.
- Recipe store → exists; Phase 3 adds CausalRecipe schema + promotion gate.

## CRITICAL: Phase 2 wiring gaps that block Phase 3's stated value
Phase 3's headline promise ("visit 2 = zero AI/exploration") requires recipes to
actually persist AND replay AND be re-verified. Right now:
- Provisional recipes are created but never promoted to `confirmed`.
- Even `confirmed` recipes only replay DOM actions, never DNR dynamic rules.
- `isRecipeValidForSite` (30-day expiry, quarantine) is never consulted.

→ Phase 3 must either (a) wire these Phase 2 pipelines, or (b) replace them
   with the CausalRecipe promotion gate. The spec implies (b) but inherits the
   store. This is the #1 architectural fork for the user.

## Release blockers the spec sets (Section 41) — all must read 0/false
policy escape, stale-epoch mutation, cross-tab leakage, rollback failure,
privacy-regressing success, unexplained benign intervention, ungated recipe
promotion, unbounded experimentation, production CDP dependency, page-injection
reaching planner as authority.
