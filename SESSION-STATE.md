# SESSION-STATE.md — ADAPT Active Working Memory

> Project: `/Users/basimhussain/Projects/adapt`

## Current goal

Finish Phase 3 causal runtime remediation, regenerate Graphify from committed source, and implement M7 offline causal-lab comparison.

## Verified implementation state (2026-08-13)

- M0/M1: live Chromium `documentId` behavior verified; runtime-wakeup/onCommitted race deduplicated; request events reject mismatched documents.
- M2: live event graph is wired to navigation, request, page, health, and mutation observations. Graphs, navigation counters, and beliefs persist in `chrome.storage.session`.
- M3: bounded selector refuses stale, multi-variable, over-budget, and non-retryable network experiments. `.invalid` no-op experiments were removed.
- M4: opaque element refs resolve only in the content script. Apply and rollback require direct ACKs, experiments settle, measure, and then restore all effects.
- M5: beliefs accumulate by origin/mechanism/causal signature across visits. Wilson success intervals, Student-t effect intervals, and minimum n=5 prevent small-n support.
- M6: operational DRAFT replay remaps current opaque targets, measures health, rolls back, invalidates on mismatch/failure, and derives replay/privacy evidence from transaction records.
- Real Chromium Phase 3 proof: session graph/records, SPA versus full navigation identity, and forced MV3 execution termination recovery.
- M7: causal-learn 0.1.4.4 benchmark completed across PC/GES/FCI, 12 families, and 216 development/holdout runs. All recovered held-out skeletons in this synthetic corpus, but no algorithm passed the definite-orientation precision gate; all remain research-only.

## Remaining

- [x] Commit remediated M0-M6 source and tests (`47e10ea`).
- [x] Regenerate and audit Graphify from the committed M0-M6 tree (786 nodes, 1,920 edges, 43 communities, 67 flows).
- [x] M7 `tools/causal-lab`: PC/GES/FCI comparison against fixture ground truth with held-out decision.
- [ ] Final full-suite and artifact audit.

## Evidence boundary

The legacy Phase 1.5 suites are real Chromium tests, but several historical scenario names overstated what they exercised. The new `phase3-causal-live.test.ts` is the direct worker/session/document proof. M7 is not complete until its dependency pin, fixture generator, metrics, and holdout report exist.
