# SESSION-STATE.md — ADAPT Active Working Memory

> Project: `/Users/basimhussain/Projects/adapt`

## Current goal

Independently re-verify Phase 3 against the Phase 3.5 SAEI prerequisite contract, add the canonical fresh-Chromium acceptance runner and reports, then begin Phase 3.5 only after an explicit `PHASE 3 VERIFIED` verdict.

## Verified implementation state (2026-08-13)

- M0/M1: live Chromium `documentId` behavior verified; runtime-wakeup/onCommitted race deduplicated; request events reject mismatched documents.
- M2: live event graph is wired to navigation, request, page, health, and mutation observations. Graphs, navigation counters, and beliefs persist in `chrome.storage.session`.
- M3: bounded selector refuses stale, multi-variable, over-budget, and non-retryable network experiments. `.invalid` no-op experiments were removed.
- M4: opaque element refs resolve only in the content script. Apply and rollback require direct ACKs, experiments settle, measure, and then restore all effects.
- M5: beliefs accumulate by origin/mechanism/causal signature across visits. Wilson success intervals, Student-t effect intervals, and minimum n=5 prevent small-n support.
- M6: operational DRAFT replay remaps current opaque targets, measures health, rolls back, invalidates on mismatch/failure, and derives replay/privacy evidence from transaction records.
- Real Chromium Phase 3 proof now includes the original two-hypothesis discriminator, rollback/confidence fall, true-mechanism support, RecipeSafe promotion, real browser restart with zero exploration, modified-detector invalidation, SPA/full-navigation identity, and forced MV3 execution termination recovery.
- M7: the fully pinned clean environment reproduces causal-learn 0.1.4.4 across PC/GES/FCI, 12 families, and 216 development/holdout runs. Independent raw-row recomputation confirms no algorithm passes the definite-orientation precision gate; all remain research-only.

## Remaining

- [x] Commit remediated M0-M6 source and tests (`47e10ea`).
- [x] Regenerate and audit Graphify from the current Stage A tree (841 nodes, 2,006 edges, 100% extracted, portable).
- [x] M7 `tools/causal-lab`: PC/GES/FCI comparison against fixture ground truth with held-out decision (`f0686a5`).
- [x] Final audit: typecheck, production build, 27 unit files/140 tests, 6 Chromium files/32 tests, security subset, 4 M7 invariants, deterministic 216-run benchmark, raw recomputation, and Graphify portability/structure all pass.
- [x] Recompute every Phase 3 claim from artifacts and raw results.
- [x] Implement and run the complete fresh-profile 20-step Phase 3 acceptance contract.
- [x] Add `npm run verify:phase3` and the five-minute user acceptance guide.
- [x] Write `docs/phase3/FINAL-ACCEPTANCE-2026-08-13.md` with `PHASE 3 VERIFIED`.
- [ ] Begin Phase 3.5 implementation (not started in Stage A).

## Evidence boundary

The legacy Phase 1.5 suites are real Chromium tests, but several historical scenario names overstated what they exercised. The new `phase3-causal-live.test.ts` is the direct worker/session/document proof. M7 is synthetic offline evidence, not production causal-effect identification; online support still requires a document-scoped reversible intervention, measured health improvement, privacy preservation, and verified rollback.
