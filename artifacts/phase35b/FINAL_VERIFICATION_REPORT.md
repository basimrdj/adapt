# PHASE 3.5B LIVE AUTONOMY VERIFIED

Generated: 2026-08-15T23:23:20+05:00

## Verdict

**PHASE 3.5B LIVE AUTONOMY VERIFIED**

- Branch: `feat/phase31b-page-plane`
- Final commit SHA: `f45ca67a3aad9d19ad8543f57a7725576b8d3617`
- PR #2: draft and unmerged.
- Reserved real-world streaming blind holdout: untouched and not inspected.
- `.commandcode/`: absent.

## Verification metadata

- Canonical Phase 3.1B evidence run: `phase31b-1786816113625-f45ca67a3aad`.
- Live autonomy evidence run: `phase31b-1786816440535-f45ca67a3aad`.
- Source commit SHA in all generated evidence: `f45ca67a3aad9d19ad8543f57a7725576b8d3617`.
- Canonical Phase 3.1B build fingerprint: `58c4a6bafb414362bba273926cd78a1c5dc51788517512e8645fe6a8cd90385a`.
- Live autonomy build fingerprint: `b1dc88b717d367945b79ab10acb1629474523ad5ed9fe83ecf3b197b1867578e`.
- Canonical artifact integrity: PASS; standalone and aggregate totals reconcile.

## Active scenario coverage

- Active trials: `96`.
- Distinct behavioral templates: `36`.
- Active mechanism families: `16`.
- Every active trial manifested its intended mechanism: `96/96`.
- Unmanifested active scenarios: `0`.
- Manifestation evidence was recorded for every active scenario.
- Label-only mechanisms were removed from active-template counting.

Active mechanisms covered:

- `anti-block-overlay`, `bait-reaction`, `confounder`, `delayed-popup`.
- `mutation-burst`, `network-probe`, `player-obstruction`, `pointer-lock`.
- `popunder-focus-split`, `popup`, `redirect-chain`, `reinsertion`.
- `same-tab-navigation`, `scroll-only-gate`, `semantic-inline-gate`, `spa-gate`.

## Detection and resolution

- `sensor_detection_rate`: `1.00` (`96/96`).
- `causal_detection_rate`: `1.00` (`96/96`).
- `preempted_by_static_filter_rate`: `0.00` (`0/96`).
- `deterministic_resolution_rate`: `0.00`.
- `saei_resolution_rate`: `1.00` (`96/96`).
- `overall_adapt_resolution_rate`: `1.00` (`96/96`).
- Headline `autonomousDetectionRate`: `1.00` from emitted anomaly or causal evidence.
- Active resolution: `96/96`.
- Capability gaps: `0`.
- Negative controls preserved: `48/48`.
- Negative-control preservation: `1.00`.
- Protected-flow false positives: `0`.
- Critical false positives: `0`.
- False-positive rate: `0.00`.
- Median time to resolution: `164.5 ms`.
- Median experiments: `1`.
- P95 experiments: `1`.

Autonomy status counts reflect active trial outcomes:

- Detected: `96`.
- Attempted: `96`.
- Resolved: `96`.
- Rolled back: `0` final status records; rollback evidence is reported separately as `96/96` successful experiment rollbacks.
- Capability gap: `0`.
- Policy abstention: `0`.
- Timed out: `0`.

## Protected controls

- Real document/download preservation: `1.00`.
- Intended document/download initiation observed: PASS.
- ADAPT suppression of the protected action: `0`.
- Autonomy primitive targeting the protected action: `0`.
- Target-blank and external-target controls preserved.
- OAuth, payment, modified-click, normal-SPA, and benign-modal controls preserved.
- Legitimate popup false-positive rate: `0.00`.
- Unwanted popup recall: `1.00`.

## Service-worker lifecycle

- Worker stop/restart/recovery: `1.00` (`1/1`).
- Method: verified CDP `ServiceWorker.stopWorker` or equivalent target lifecycle control.
- Old target ID: `75178A1FE4B6BCFADD71CB2B9EF5E1D3`.
- `workerStopped`: `true`.
- New target ID: `57C864121953C11CD7DF40985A12BFE6`.
- `workerRecreated`: `true`.
- `stateRestored`: `true`.
- Pending transaction reconciled: `true`.
- Old and new target IDs differ.

## Primitive coverage

- `executable_primitive_test_coverage`: `1.00`.
- `primitive_vocabulary_coverage`: `12/16` (`0.75`).
- Browser-tested executable primitives: `12`.
- Capability gaps in the vocabulary remain explicit and are not counted as tested primitives.
- Solved popup capability gaps: `0`.
- Popup closure stops after mechanism-specific verification; no follow-on navigation-target quarantine gap is recorded.

## Recipe lifecycle

- Visit 1 experiments: `1` → `DRAFT`.
- Visit 2 experiments: `0` → `CONFIRMED`.
- Visit 3 experiments: `0` → `RECIPE_SAFE`.
- Visit 4 experiments: `0` → `RECIPE_SAFE`.
- AI calls: `0`.
- Recipe replay success: `1.00` across `54` eligible trials.
- Rollback success: `1.00` across `96` eligible active trials.

## Local gates

- Typecheck: PASS.
- Build, integrity, benchmark, and security checks: PASS.
- Phase 3.1B verifier: PASS.
- Adversarial scenarios: `30/30` PASS.
- Stealth scenarios: `11/11` PASS.
- End-to-end tests: `69` PASS.
- Unit tests: `171` PASS.
- T04 causal verifier: `20/20` PASS.
- `autonomy-fast`: PASS.
- `autonomy-live`: PASS.
- Full live profile: PASS with `96` active trials and `48` negative controls.

## GitHub Actions

Final workflow run: `31899343595` on commit `f45ca67a3aad9d19ad8543f57a7725576b8d3617`.

- Typecheck job: `95047537806` — PASS.
- Page-unit job: `95047537719` — PASS.
- Autonomy-fast job: `95047537728` — PASS.
- Build-integrity-security job: `95047537735` — PASS.
- Autonomy-live job: `95048935822` — PASS.

## Final gate

All required final thresholds pass without lowering them:

- Every active scenario manifests: PASS.
- True sensor detection ≥ `95%`: PASS at `100%`.
- Overall active resolution ≥ `90%`: PASS at `100%`.
- Negative-control preservation: PASS at `100%`.
- Real document/download preservation: PASS at `100%`.
- Popup recall ≥ `95%`: PASS at `100%`.
- Legitimate popup false positives: PASS at `0`.
- Actual worker stop/restart/recovery: PASS at `100%`.
- Artifact consistency: PASS.
- Contradictory evidence: none.
- Phase 3.1B green: PASS.
- `autonomy-fast` green: PASS.
- `autonomy-live` green: PASS.
