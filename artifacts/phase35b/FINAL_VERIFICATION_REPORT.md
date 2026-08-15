# PHASE 3.5B LIVE AUTONOMY VERIFIED

## Verdict

**PHASE 3.5B LIVE AUTONOMY VERIFIED**

- Branch: `feat/phase31b-page-plane`
- Current commit SHA: `20af30dbb308efbc2e28fe46e8cd8e493ec7bbcf`
- PR #2: draft and unmerged
- Working tree: contains the Phase 3.5B implementation and generated evidence as uncommitted changes

## T04 causal trace

- Independent Chromium runs: `20/20`
- Selected primitive: `REMOVE_REACTION_UI`
- Deterministic `BLOCKED_RESOURCE_PROBE`: abstained rather than owning the graph
- Root cause: the old orchestration allowed the deterministic blocked-probe candidate to take ownership before reaction removal was selected
- Fix: bounded SAEI ownership, mechanism-specific outcome verification, and complete causal sequencing
- Health before: content access `0.6`, scrollability `0.1`, visual obstruction `1`
- Health after: content access `1`, scrollability `1`, visual obstruction `0`
- Rollback: verified `true`; fallback invocation: `false`

## Primitive execution matrix

Browser-tested and marked `EXECUTABLE_AND_BROWSER_TESTED`:

- `TEMPORARY_NETWORK_BLOCK`
- `TARGETED_SESSION_DNR`
- `TEMPORARY_NETWORK_ALLOW`
- `PRESERVE_BAIT`
- `RESTORE_LAYOUT`
- `TOGGLE_COSMETIC_ACTION`
- `REMOVE_REACTION_UI`
- `RESTORE_POINTER_INTERACTION`
- `PLAYER_HEALTH_RECOVERY`
- `CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET`
- `STOP_MATCHED_REDIRECT_CHAIN`
- `RESTORE_SCROLL`

Capability gaps remain explicit for:

- `ACTIVATE_PACKAGED_SCRIPTLET`
- `DISABLE_PACKAGED_SCRIPTLET`
- `QUARANTINE_NAVIGATION_TARGET`
- `SUPPRESS_MATCHED_WINDOW_OPEN_BEHAVIOR`

The browser probe artifact contains `11` tested executors with stage, observable effect, health safety, rollback, and restored-baseline evidence; all passed.

## Live holdouts

Fast CI profile:

- Active trials: `24`
- Negative controls: `16`
- Detection: `1.00`
- Resolution: `1.00`
- False-positive rate: `0`
- Recipe replay: `1.00`
- Second-visit SAEI experiments: `0`
- Popup unwanted-target recall: `1.00`
- Popup legitimate-target false-positive rate: `0`
- Rollback success: `1.00`
- Worker restart: `1.00`

Full local/release profile:

- Active trials: `96`
- Negative controls: `48`
- Result count: `144`
- Detection: `1.00`
- Resolution: `1.00`
- False-positive rate: `0`
- Recipe replay: `1.00`
- Second-visit SAEI experiments: `0`
- Popup unwanted-target recall: `1.00`
- Popup legitimate-target false-positive rate: `0`
- Rollback success: `1.00`
- Worker restart: `1.00`
- Median time to resolution: `5266 ms`
- Capability gaps: `48`, all from the intentionally unsupported quarantine branch after popup closure

## Recipe lifecycle

- Visit 1: `1` experiment → `DRAFT`
- Visit 2: `0` experiments → `CONFIRMED`
- Visit 3: `0` experiments → `RECIPE_SAFE`
- Visit 4: `0` experiments → `RECIPE_SAFE`
- Visit AI calls: `0`
- `RECIPE_SAFE` visit SAEI exploration: `0`

## Scores and CI

- Synthetic autonomy: detection `1.00`, resolution `1.00`, false positives `0`, median experiments `1`, p95 experiments `3`, median resolution `660 ms`, recipe replay `1.00`, AI calls `0`
- Real autonomy: detection `1.00`, resolution `1.00`, false positives `0`, median experiments `1`, p95 experiments `1`, recipe replay `1.00`, primitive coverage `1.00`, rollback `1.00`
- Phase 3.1B verifier: `PASSED`; all `11` gates passed, including typecheck, build, integrity, unit, stealth, adversarial, runtime, E2E, and security checks
- `autonomy-fast`: `PASSED` locally through `ADAPT_PHASE31_OFFLINE=1 npm run verify:autonomy`
- `autonomy-live`: `PASSED` locally on the fast `24/16` profile
- T04 causal verifier: `PASSED`, `20/20`
- Remote GitHub Actions run IDs: none available; `gh` was unavailable and the current fix is uncommitted, so no new remote CI run was created

## Licensing and holdout status

- Licensing: still a distribution blocker for a proprietary release; `docs/phase31b/LICENSE_REVIEW.md` records the unresolved project license and GPL-3.0 AdGuard build-toolchain review
- Reserved real-world streaming blind holdout: untouched and not inspected
