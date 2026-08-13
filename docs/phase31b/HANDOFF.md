# Phase 3.1B Engineering Handoff

STATUS
------
IMPLEMENTED — VERIFICATION GREEN; RELEASE BLOCKED

BRANCH
------
feat/phase31b-page-plane

COMMITS
-------
Pending local commit.

PULL REQUEST
------------
Pending push and PR creation.

ARCHITECTURE IMPLEMENTED
------------------------
Network plane: existing v6 maintained DNR compiler and capacity-aware shards.
Page plane: independently implemented typed cosmetic/procedural compiler,
document-start CSS, domain/exception matching, bounded mutation reapplication,
and audited isolated/Main scriptlet boundary.
Anti-adblock plane: existing Phase 3 causal graph, rollback, health, and recipe
promotion preserved.
AI plane: existing advisory deterministic → AI → abstain cascade preserved;
known page rules do not call AI.

MAJOR FILES CHANGED
-------------------
`src/page/filtering/compiler.ts` → parses maintained page-filter syntax.
`src/page/filtering/runtime.ts` → bounded frame-local page runtime.
`src/page/filtering/scriptlets.ts` → audited isolated/procedural primitives.
`scripts/build-page-filtering.ts` → reproducible page artifacts and manifest.
`scripts/verify-phase31b.ts` → authoritative verification gate.
`tests/fixtures/phase31b/adversarial-corpus.json` → deterministic lab matrix.

FILTER COVERAGE
---------------
Network rules: existing Phase 3.1 v6 corpus.
Cosmetic rules: 68,185 compiled records in the current cache.
Exceptions: 1,623 compiled records.
Scriptlet rules: 7,631 parsed; 1,860 supported by the audited allowlist.
Procedural/extended rules: bounded `:has-text`, `:matches-css`, `:remove`, and
`:remove-attr`; unsupported forms are recorded.
Redirect resources: existing v6 path, subject to the license review.

TEST RESULTS
------------
Typecheck: PASS.
Unit: 145 tests PASS, including 140 baseline and 5 page/lab tests.
Phase 3 regression: PASS; acceptance sequence commits the true mechanism.
Page filtering: 5 focused tests PASS; integrity gate PASS.
Anti-adblock: 1 synthetic Chromium test PASS.
Runtime: 1 body-replacement/mutation-stability test PASS.
Chromium E2E: 34 tests PASS across 8 files.
Bundle security: 4 tests PASS.
Authoritative command: PASS on 2026-08-13 UTC.
Machine evidence: `artifacts/phase31b/latest.json`.

REAL-WORLD RESULTS
------------------
Site/category: synthetic local lab only.
Blocking: generic fixture coverage is automated; broad live-site coverage is pending.
Detector behavior: causal synthetic coverage is retained; no universal claim.
Breakage: local fixture keeps main content and SPA churn alive.
Notes: comparative uBO Lite/AdGuard/no-blocker benchmarks are not complete.

YOUTUBE
-------
Pre-roll: not observed in this run.
Mid-roll: not observed in this run.
Display/sponsored: compiler preserves maintained rules; live result pending.
Playback: not manually validated in this run.
SPA: runtime re-applies on history events; live validation pending.
Errors: hostile DOM protections retained; final Chromium gate passed.

PERFORMANCE
-----------
Measured overhead: mutation work is coalesced and bounded; comparative
benchmark pending.
Service-worker behavior: baseline page filtering is content-script/data driven.
Idle behavior: no permanent polling; mutation work is coalesced and bounded.
Comparison summary: not yet available.

SECURITY
--------
Remote code: none in the new page plane.
Secrets: bundle integrity gate rejects known secret/development markers.
MAIN-world scriptlets: only top-level `set-constant` is allowlisted.
WAR exposure: bounded and dynamic when present.
License status: unresolved GPL build-toolchain review blocks proprietary release.

AI
--
Known-site AI calls: zero by design.
Novel-path behavior: existing causal evidence and bounded experiment path.
Validator: existing `PolicyValidator` remains authoritative.
Recipe promotion: existing successful-intervention promotion preserved.

KNOWN LIMITATIONS
-----------------
The page bundle is currently large, unsupported maintained syntax is explicit,
closed shadow roots are not claimed, live YouTube and broad real-world
comparison are pending, and the GPL build-toolchain decision is unresolved.

VERIFICATION COMMAND
--------------------
npm run verify:phase31b

MERGE RECOMMENDATION
--------------------
NO for proprietary release until licensing consent/replacement and live
validation are resolved. Engineering verification itself is green.

USER ACTION REQUIRED
--------------------
Choose compatible licensing for the current AdGuard build path or approve its
replacement before distributing ADAPT as proprietary software. Provide one
clean-profile YouTube ad/playback observation for the final acceptance matrix.
