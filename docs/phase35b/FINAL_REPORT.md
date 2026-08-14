# ADAPT Phase 3.5B Final Report

## Verdict

**PHASE 3.5B NOT VERIFIED**

The production execution path is implemented and exercised by a real Chromium
holdout, but the acceptance thresholds are not met. The branch remains draft
and unmerged.

## Revision

- Branch: `feat/phase31b-page-plane`
- Old SHA at takeover: `d2bdf36356d44e38fe185a0f8487f23ac9c90fe0`
- Phase 3.5 implementation SHA: `cb21df8` (`Close Phase 3.5B live autonomy gap`)
- Final implementation head: `a3ac86c` (`Make browser gates portable across CI`)
- Pull request: `#2`, still draft and unmerged
- GitHub mergeable field: **MERGEABLE**; acceptance mergeable: **No** because the required autonomy gate failed
- Reserved real-world blind holdout: not inspected, searched, or tested

## Coverage split

### 1. Static / blocking coverage

The existing Phase 3.1B static/page-plane behavior remains in place. Typecheck,
the targeted unit suite, stealth corpus, and most existing Phase 3.1B gates pass
in the recorded runs. The final full Phase 3.1B verifier is not green because
of three Chromium failures: blocked-probe gate T04, pointer-lock navigation
timeout, and the derived 30-row corpus total reporting 29 passing rows.

### 2. Synthetic algorithmic autonomy

The synthetic holdout remains separate from live browser scoring. A direct
algorithmic run over 128 unseen scenarios recorded:

- detection: `1.0`
- resolution: `0.7454545454545455`
- false positives: `0`
- recipe replay: `0.7454545454545455`
- capability gaps: `0`

The hardened verifier refuses to print PASS because synthetic resolution is
below the `0.90` threshold.

### 3. Real browser autonomy

Final artifact: `artifacts/phase35b/AUTONOMY_LIVE_SCORE.json`.

- active trials: `4`
- negative controls: `4`
- autonomous detection rate: `1`
- autonomous resolution rate: `0.5`
- false-positive rate: `0`
- critical false positives: `0`
- median experiments: `1`
- p95 experiments: `2`
- median time to resolution: `null`
- capability gaps: `8`
- policy abstentions: `0`
- rollback success rate: `0.5`
- popup unwanted-target recall: `0`
- legitimate popup false-positive rate: `0`

The two overlay trials reached a real committed reversible repair. Popup
closure did not reach a browser-proven autonomous intervention in the final
run, so the evaluator no longer counts evaluator cleanup as resolution.

### 4. Worker restart

Final artifact: `artifacts/phase35b/WORKER_RESTART_RESULTS.json`.

- deterministic trials: `1`
- successful recoveries: `1`
- recovery rate: `1.0`

The probe persisted pending autonomy state, terminated the extension worker via
CDP, restored state, reconciled the pending transaction, and observed safe
completion.

### 5. Real recipe replay

Recipe replay is wired to the real `CausalRecipeStore`, `PromotionGate`,
fingerprint checks, rollback verification, and `maybeReplay()` path. The final
live corpus recorded `recipe_replay_success_rate: 0` and
`second_visit_experiments: 0`; no `RECIPE_SAFE` replay acceptance is claimed.

### 6. Actual AI calls

Final artifact: `artifacts/phase35b/AI_USAGE.json`.

- planner configured: `false`
- actual AI calls: `0`
- reason: no safe production Phase 2 planner is wired into SAEI

No fabricated AI path was added. Deterministic SAEI remains authoritative until
the bounded planner can be connected without widening the execution surface.

### 7. Remaining capability gaps

The binary matrix is in `artifacts/phase35b/PRIMITIVE_EXECUTION_MATRIX.json`.
Only `REMOVE_REACTION_UI` and `RESTORE_SCROLL` are marked
`EXECUTABLE_AND_BROWSER_TESTED`. The remaining 14 rows are explicit
`CAPABILITY_GAP` states covering untested DNR/network paths, untested pointer,
layout, player, and navigation paths, missing scriptlet rollback proof, unsafe
window-open interception, and missing reversible quarantine.

### 8. False positives

The final live holdout recorded zero false positives, zero critical false
positives, and zero false positives on legitimate target-blank and OAuth-like
controls. This does not compensate for failed active-trial resolution.

### 9. Licensing

No GPL/LGPL implementation source was copied or expanded. The existing
AdGuard build-toolchain licensing blocker remains separate and proprietary
release clearance is not claimed.

### 10. Real-world holdout status

The reserved real-world streaming holdout remains untouched. No hostname rule,
selector, warning text, popup URL, or site-specific knowledge was added.

## Exact commands run

- `npm run typecheck`
- `npm run test:unit`
- `npx vitest run tests/unit/autonomy tests/unit/causal-promotion.test.ts tests/unit/causal-session-state.test.ts --reporter=dot`
- `npm run verify:autonomy:live`
- `ADAPT_PHASE31_OFFLINE=1 npm run verify:autonomy`
- `npx tsx -e "...generateAutonomyScenarios...scoreAutonomy..."`
- `git diff --check`
- `jq empty artifacts/phase35b/*.json`

The last live command intentionally exited nonzero after writing its artifacts:
`PHASE 3.5B LIVE AUTONOMY VERIFICATION: FAIL`.

## Exact test totals

- Targeted autonomy/causal validation: `9` files, `36` tests passed
- Full unit suite: `39` files, `169` tests passed
- Existing Phase 3.1B Chromium verifier final run: `66` passed, `3` failed
- Final CI Chromium E2E subset: `8` files and `68` tests passed, `1` file and
  `1` test failed (`tests/e2e/extension-e2e.test.ts`, blocked-probe T04)
- Real browser autonomy holdout: `4` active trials, `4` negative controls

## Exact changed files

- `.github/workflows/phase31b.yml`
- `artifacts/phase35b/AI_USAGE.json`
- `artifacts/phase35b/AUTONOMY_LIVE_SCORE.json`
- `artifacts/phase35b/LIVE_HOLDOUT_RESULTS.json`
- `artifacts/phase35b/PRIMITIVE_EXECUTION_MATRIX.json`
- `artifacts/phase35b/WORKER_RESTART_RESULTS.json`
- `docs/phase35/FINAL_REPORT.md`
- `docs/phase35b/AI_ROUTING.md`
- `docs/phase35b/ARCHITECTURE.md`
- `docs/phase35b/FINAL_REPORT.md`
- `docs/phase35b/FINAL_VERIFICATION.md`
- `docs/phase35b/HOLDOUT_DESIGN.md`
- `docs/phase35b/LIVE_EXECUTION.md`
- `docs/phase35b/PRIMITIVE_MATRIX.md`
- `docs/phase35b/PRE_IMPLEMENTATION_AUDIT.md`
- `docs/phase35b/WORKER_RESTART.md`
- `package.json`
- `scripts/verify-autonomy-live.ts`
- `scripts/verify-phase3.ts`
- `scripts/verify-autonomy.ts`
- `src/background/autonomy/executor-registry.ts`
- `src/background/autonomy/intent-tracker.ts`
- `src/background/autonomy/navigation-targets.ts`
- `src/background/autonomy/popup-classifier.ts`
- `src/background/autonomy/primitive-registry.ts`
- `src/background/autonomy/saei.ts`
- `src/background/autonomy/session.ts`
- `src/background/causal/orchestrator.ts`
- `src/background/causal/promotion-gate.ts`
- `src/entrypoints/background.ts`
- `src/page/intent-envelope.ts`
- `src/page/sensor.ts`
- `src/shared/causal/events.ts`
- `src/shared/causal/recipes.ts`
- `src/shared/messages.ts`
- `src/shared/types.ts`
- `tests/unit/autonomy/executor-registry.test.ts`
- `tests/unit/autonomy/primitive-registry.test.ts`
- `tests/e2e/content-runtime-stability.test.ts`
- `tests/e2e/extension-e2e.test.ts`
- `tests/e2e/phase3-acceptance-sequence.test.ts`
- `tests/e2e/phase3-causal-live.test.ts`
- `tests/e2e/phase3-recipe-lifecycle.test.ts`
- `tests/e2e/phase3-restart-invalidation.test.ts`
- `tests/e2e/phase31b-adversarial.test.ts`
- `tests/e2e/release-gate-matrix.test.ts`
- `tests/e2e/stealth.test.ts`
- `tests/support/chrome-executable.ts`

## CI status

The workflow contains explicit `autonomy-fast` and `autonomy-live` jobs running
the required autonomy commands. All build, typecheck, page-unit, and security
jobs pass on the final implementation head, and both autonomy jobs prime the
validated Phase 3.1 filter cache before entering offline verification.

The final implementation head was evaluated by these duplicate workflow runs:

- `31823372490` — failed only in `autonomy-fast`; `typecheck`, `page-unit`,
  and `build-integrity-security` passed; `autonomy-live` was skipped because
  it depends on `autonomy-fast`.
- `31823370004` — same result on the duplicate push/PR workflow trigger.

The final `autonomy-fast` run reached the real Chromium suites. The portable
resolver successfully launched Puppeteer Chrome and the stealth suite passed
(`2/2`). The remaining failure is the genuine blocked-probe T04 assertion in
`tests/e2e/extension-e2e.test.ts`: the expected gate removal was false. This is
an application/test behavior failure, not a missing-browser or offline-cache
setup failure. The live report above remains authoritative and the final
verdict remains **PHASE 3.5B NOT VERIFIED**.

## Final report SHA

## Continuation Update — 2026-08-14

This continuation fixed the T04 regression in the production orchestration
path. The root cause was partial-evidence SAEI ranking plus concurrent staging
of the same graph; the loop could spend its bounded budget on scroll/layout
probes before reaching `REMOVE_REACTION_UI`. Live selection now honors each
primitive's declared evidence, suppresses concurrent staging, and records the
successful run in `artifacts/phase35b/T04_CAUSAL_TRACE.json`.

- T04: `20/20` independent Chromium runs passed.
- T03/T04/T05 targeted regression: `3/3` passed.
- Primitive-specific verification now covers scroll restoration, reaction-UI
  removal, pointer/player safety floors, network preservation, and navigation
  outcome contracts.
- Pending popup closure is reconciled across same-tab source navigation and
  stale handled navigation refs are not re-explored.
- Latest live score: detection `1.0`, resolution `0.25`, median resolution
  time `6075ms`, false positives `0`, worker restart `1.0`, popup recall `0`,
  recipe replay `0`, primitive browser coverage `0.125`, rollback `0.25`.
- Final verdict remains **PHASE 3.5B NOT VERIFIED** because popup recall,
  recipe replay, rollback coverage, and primitive browser coverage remain below
  hard thresholds.

The final report commit SHA is supplied in the agent handoff after this file is
committed, because a commit cannot contain its own hash without changing that
hash.
