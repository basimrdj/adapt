# Phase 3.1B Engineering Handoff

STATUS
------
IMPLEMENTED — VERIFICATION GREEN; RELEASE BLOCKED

BRANCH
------
feat/phase31b-page-plane

COMMITS
-------
- `4754dbb` feat: add Phase 3.1B compiled page filtering
- `f6823f5` fix: continue causal sequence after rollback
- `2b63d07` test: stabilize Chromium extension fixtures
- `4fa20b9` docs: record Phase 3.1B verification

PULL REQUEST
------------
Draft PR #2 opened against `main`.
https://github.com/basimrdj/adapt/pull/2

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
`artifacts/phase31b/unsupported-scriptlet-frequency.json` → unsupported
maintained-scriptlet demand report.

FILTER COVERAGE
---------------
Network rules: existing Phase 3.1 v6 corpus.
Cosmetic rules: 68,185 compiled records in the current cache.
Exceptions: 1,623 compiled records.
Scriptlet rules: 7,631 parsed; 4,473 fully executable; 2,884 unsupported by
name; 49 unsupported by arguments; 225 unsafe; 6 exception-suppressed.
The generated frequency report ranks the remaining unsupported names by rule
demand; the highest-impact next primitives remain an explicit backlog and are
not counted as supported.
Procedural/extended rules: bounded `:has-text`, `:matches-css`, `:remove`, and
`:remove-attr`; unsupported forms are recorded.
Redirect resources: existing v6 path, subject to the license review.

TEST RESULTS
------------
Typecheck: PASS.
Unit: 151 tests PASS across 32 files.
Phase 3 regression: PASS; acceptance sequence commits the true mechanism.
Page filtering: 8 focused tests PASS; integrity gate PASS.
Anti-adblock: 30/30 executable corpus scenarios PASS.
Runtime: 1 body-replacement/mutation-stability test PASS.
Chromium E2E: 65 tests PASS across 8 files.
Bundle security: 4 tests PASS.
Authoritative command: `ADAPT_PHASE31_OFFLINE=1 npm run verify:phase31b` PASS on
2026-08-13 UTC.
Machine evidence: `artifacts/phase31b/latest.json`.

REAL-WORLD RESULTS
------------------
Site/category: synthetic local lab only.
Blocking: executable corpus is green; broad clean-profile live-site comparison is pending.
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
Previous monolithic index: 15,022,819 bytes. New startup index: 412 bytes.
Total page-filtering artifacts: 30,235,251 bytes. YouTube sample per-frame
load: 1,760,804 bytes; parse: 9.6 ms; selected indexed rules: 735; mutation
lookup: 0.15 ms for 2,000 checks. No full bundle parse occurs per frame.
Service-worker behavior: baseline page filtering is content-script/data driven.
Idle behavior: no permanent polling; mutation work is coalesced and bounded.
The benchmark is a local indexed-artifact benchmark, not a live-site CPU or
memory claim. Clean-profile uBO Lite/AdGuard MV3/no-blocker comparison remains
pending.

SECURITY
--------
Remote code: none in the new page plane.
Secrets: bundle integrity gate rejects known secret/development markers.
MAIN-world scriptlets: audited allowlist only; descriptors are fully validated
before execution.
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
The total page artifacts remain large even though per-frame loading is indexed;
unsupported maintained syntax is explicit, closed shadow roots are not claimed,
live YouTube and broad real-world comparison are pending, and the GPL
build-toolchain decision is unresolved.

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
