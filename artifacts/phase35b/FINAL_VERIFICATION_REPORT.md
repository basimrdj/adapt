# PHASE 3.5B LIVE AUTONOMY NOT VERIFIED

Generated: 2026-08-15T17:37:59+05:00

## Verdict

**PHASE 3.5B NOT VERIFIED**

- Branch: `feat/phase31b-page-plane`
- Current HEAD SHA: `daf95fdf28798200e1aec39210dede013060dff9`
- Working tree: Phase 3.5B fixes and evidence remain uncommitted.
- PR #2: draft and unmerged.
- Final verdict is blocked by the required GitHub Actions `autonomy-live` job still failing on the checked-out pre-fix commit. No remote run exists for the uncommitted local fixes.

## T04 causal trace

- Independent Chromium runs: `20/20`.
- Selected primitive: `REMOVE_REACTION_UI` on all 20 runs.
- All 20 runs committed the intervention, removed the gate, restored content health, and verified rollback.
- Health before: content access `0.6`, scrollability `0.1`, visual obstruction `1`.
- Health after: content access `1`, scrollability `1`, visual obstruction `0`.
- Rollback: `20/20` verified; fallback invocation `false`.

## Primitive execution matrix

The matrix contains `12` `EXECUTABLE_AND_BROWSER_TESTED` entries:

- `11` standalone executor probes passed stage, observable effect, health safety, rollback, and restored-baseline checks:
  - `TEMPORARY_NETWORK_BLOCK`
  - `TARGETED_SESSION_DNR`
  - `TEMPORARY_NETWORK_ALLOW`
  - `PRESERVE_BAIT`
  - `RESTORE_LAYOUT`
  - `TOGGLE_COSMETIC_ACTION`
  - `REMOVE_REACTION_UI`
  - `RESTORE_POINTER_INTERACTION`
  - `PLAYER_HEALTH_RECOVERY`
  - `STOP_MATCHED_REDIRECT_CHAIN`
  - `RESTORE_SCROLL`
- `CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET` is browser-proven through the live popup holdout, not counted merely because its executor exists.
- Capability gaps remain explicit:
  - `ACTIVATE_PACKAGED_SCRIPTLET`
  - `DISABLE_PACKAGED_SCRIPTLET`
  - `QUARANTINE_NAVIGATION_TARGET`
  - `SUPPRESS_MATCHED_WINDOW_OPEN_BEHAVIOR`

Successful popup closure stops immediately after mechanism-specific verification: solved popup cases have `0` capability gaps and `0` `QUARANTINE_NAVIGATION_TARGET` follow-on records.

## Live browser holdout

Full local/release profile:

- Active trials: `96`.
- Negative controls: `48`.
- Total trials: `144`.
- Active resolved: `96`.
- Negative controls preserved: `48`.
- Active detection rate: `1.00`.
- Active resolution rate: `1.00`.
- Overall ADAPT resolution rate: `1.00`.
- SAEI resolution rate: `0.6145833333` (`59/96`).
- Deterministic/static resolution rate: `0.3854166667` (`37/96`).
- Negative-control preservation rate: `1.00`.
- Protected-flow false positives: `0`.
- Critical false positives: `0`.
- False-positive rate: `0`.
- Median time to resolution: `2003.5 ms`.
- Median experiments: `1`.
- P95 experiments: `1`.
- Recipe replay success: `1.00` across `59` eligible trials.
- Rollback success: `1.00` across `59` eligible active trials.
- Worker restart success: `1.00`.
- Primitive execution coverage: `1.00`.
- Popup unwanted-target recall: `1.00`.
- Popup legitimate-target false-positive rate: `0`.
- Capability gaps in live trials: `0`.
- Active scenario templates: `27`.
- Active mechanism families include anti-block overlay, semantic gate, scroll gate, pointer lock, popup, delayed popup, popunder/focus split, redirects, SPA gate, reinsertion, mutation burst, player obstruction, network probe, bait reaction, and multi-mechanism confounders.
- Negative controls include target blank, external target blank, modified clicks, OAuth, payment, document/download, normal SPA, and benign modal.

Reporting keeps `active_resolved` and `negative_controls_preserved` separate; it does not report `144` resolved trials.

## Recipe lifecycle

- Visit 1 experiments: `1` → `DRAFT`.
- Visit 2 experiments: `0` → `CONFIRMED`.
- Visit 3 experiments: `0` → `RECIPE_SAFE`.
- Visit 4 experiments: `0` → `RECIPE_SAFE`.
- Visit AI calls: `0`.
- `RECIPE_SAFE` visit SAEI exploration: `0`.

## Scores and AI

Synthetic autonomy:

- Verdict: `PASS`.
- Unseen trials: `128`.
- Detection: `1.00`.
- Resolution: `1.00`.
- False-positive rate: `0`.
- Median experiments: `1`.
- P95 experiments: `4`.
- Median time to resolution: `660 ms`.
- Recipe replay: `1.00`.
- AI calls: `0`.
- Capability gaps: `0`.

Real deterministic autonomy:

- Detection: `1.00`.
- Active resolution: `1.00`.
- Overall ADAPT resolution: `1.00`.
- SAEI resolution: `0.6145833333`.
- Deterministic/static resolution: `0.3854166667`.
- AI calls: `0`.
- Planner authority: none; deterministic routing remains authoritative.

## Local gates

All requested corrected-tree local gates pass:

- `typecheck`: PASS.
- Build, integrity, benchmark, and security checks: PASS.
- Phase 3.1B verifier: PASS; `9` E2E files and `69` tests passed in the final verifier run.
- T04 causal verifier: PASS; `20/20`.
- `autonomy-fast`: PASS.
- `autonomy-live` fast profile: PASS.
- Full live profile: PASS; `96` active and `48` controls.

## GitHub Actions

Both current remote runs target HEAD SHA `daf95fdf28798200e1aec39210dede013060dff9` before the uncommitted fixes:

- Run `31875667783`: failed; `typecheck`, `page-unit`, `build-integrity-security`, and `autonomy-fast` passed; `autonomy-live` job `94992050571` failed.
- Run `31875665990`: failed; `typecheck`, `page-unit`, `build-integrity-security`, and `autonomy-fast` passed; `autonomy-live` job `94992267013` failed.
- No new remote run was created because the corrected changes are uncommitted and unpushed.

## Licensing and holdout status

- Licensing remains a proprietary-distribution blocker: the repository has no project `LICENSE`, the existing AdGuard build/toolchain packages are GPL-3.0-only, and filter data sources retain separate provenance obligations. See `docs/phase31b/LICENSE_REVIEW.md`.
- Reserved real-world streaming blind holdout: untouched and not inspected.
- `.commandcode/` was removed from the branch as requested.
