# ADAPT Phase 3.5 Autonomy Report

## Revision

- Branch: `feat/phase31b-page-plane`
- Commit: `d2bdf36356d44e38fe185a0f8487f23ac9c90fe0`
- Implementation commit: `d84e69e675ff300d90e2818a2df6d6abb8baa5be`
- Pull request: `#2`, still draft and unmerged
- Real-world streaming holdout: not inspected and not included in implementation data

## Architectural changes

- Added the autonomy contract and the `npm run verify:autonomy` gate.
- Promoted semantic, navigation, popup, interaction, playback, network, and
  reinsertion signals into structured causal events with coarse features,
  confidence, hashes, and opaque references.
- Added short-lived click intent envelopes and `webNavigation.onCreatedNavigationTarget`
  correlation for source/target tabs, frames, timing, destination class, opener,
  foreground state, and redirect evidence.
- Added a bounded unknown-hypothesis lattice and SAEI loop with policy filtering,
  one-variable experiments, health observation, rollback, sequential belief
  updates, capability-gap recording, and deterministic promotion.
- Added MV3 session-backed autonomy state so in-progress causal reasoning survives
  service-worker termination.
- Preserved the legacy deterministic fallback before autonomous unknown-family
  experiments when a signal is already expressible by the shipped strategy ladder.
- Semantic confidence now uses the count of matched coarse signals, not retained
  raw phrases, preventing privacy-preserving redaction from weakening known-case
  fallback behavior.

## Causal event types

`ANTI_BLOCK_REACTION`, `SEMANTIC_GATE`, `INTERACTION_DENIED`,
`PLAYBACK_OBSTRUCTED`, `VISIBLE_AD_CANDIDATE`, `UNEXPECTED_NAV_TARGET`,
`POPUP_OR_POPUNDER`, `SUSPICIOUS_REDIRECT_CHAIN`, `WINDOW_OPEN_REACTION`,
`NAVIGATION_BOUNCE`, `NETWORK_PROBE_REACTION`, `REPEATED_REINSERTION`,
`UNKNOWN_REACTION`, and `USER_INTENT`.

## Hypothesis lattice

Known mechanism families remain available. Unknown bounded families are:

- `UNKNOWN_NETWORK_REACTION`
- `UNKNOWN_SCRIPT_REACTION`
- `UNKNOWN_DOM_REACTION`
- `UNKNOWN_NAVIGATION_REACTION`
- `UNKNOWN_PLAYER_REACTION`
- `UNKNOWN_MIXED_REACTION`

Unknown means audited experiments only; it never authorizes generated code,
selectors, raw URLs, arbitrary DNR, or browser commands.

## Primitive Registry

The registry ships 16 typed primitives:

`TEMPORARY_NETWORK_ALLOW`, `TEMPORARY_NETWORK_BLOCK`, `TARGETED_SESSION_DNR`,
`TOGGLE_COSMETIC_ACTION`, `PRESERVE_BAIT`, `RESTORE_LAYOUT`,
`REMOVE_REACTION_UI`, `RESTORE_SCROLL`, `RESTORE_POINTER_INTERACTION`,
`ACTIVATE_PACKAGED_SCRIPTLET`, `DISABLE_PACKAGED_SCRIPTLET`,
`QUARANTINE_NAVIGATION_TARGET`, `CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET`,
`SUPPRESS_MATCHED_WINDOW_OPEN_BEHAVIOR`, `STOP_MATCHED_REDIRECT_CHAIN`, and
`PLAYER_HEALTH_RECOVERY`.

Each definition declares allowed mechanism families, evidence, parameter schema,
execution world, risk, privacy, rollback, expected effect, and forbidden
contexts. Authentication, DRM, subscriptions, paywalls, purchases, and security
controls remain out of scope.

## Holdout lab

The seeded generator supports separate TRAIN/DEVELOPMENT and HOLDOUT splits and
combines unseen reaction classes, semantic gates, network probes, DOM mutation,
reinsertion, navigation, redirect, playback-like, and benign-control signals.
The runtime receives only structured events; expected outcomes stay in the
evaluator. This run executed 128 HOLDOUT trials, including 18 benign negative
controls and 110 active cases.

## AUTONOMY_SCORE

| Metric | Result |
|---|---:|
| `autonomous_detection_rate` | 1.0000 (100%) |
| `autonomous_resolution_rate` | 0.7455 (74.55%) |
| `false_positive_rate` | 0.0000 (0%) |
| `median_experiments` | 1 |
| `p95_experiments` | 4 |
| `median_time_to_resolution` | 660 ms |
| `recipe_replay_success_rate` | 0.7455 (74.55%) |
| `second_visit_ai_calls` | 0 |
| known-case AI calls | 0 |
| capability gaps | 0 |

The score is synthetic holdout evidence, not a claim of universal
undetectability.

## Verification

- `npm run verify:autonomy`: PASS
- Phase 3.1B typecheck/build/integrity/security: PASS
- Phase 3.1B unit suite: 166/166 passed
- Autonomy unit suites: 12/12 passed
- Passive stealth suite: 2/2 passed
- Deterministic adversarial corpus: 34/34 tests passed, including 30/30 corpus rows
- Content runtime stability: 1/1 passed
- Full Chromium E2E suite: 69/69 passed
- Phase 3 live causal/restart/recipe suites: passed
- GitHub Actions on this SHA: 6/6 checks successful across push and pull-request runs
  (`31812500867` and `31812507099`)

## Capability gaps

The autonomy run recorded zero synthetic capability gaps. This does not imply
that every real-world mechanism is expressible; a genuinely new primitive must
be recorded as `CAPABILITY_GAP` and expanded offline rather than executing
remote generated code.

## Merge recommendation

**Do not merge or ship as a proprietary release yet.** The technical Phase 3.5
and Phase 3.1B gates are green, but the existing licensing review remains an
unresolved release blocker and the real-world blind holdout still requires a
clean-profile evaluator revisit. No hostname-specific rule or knowledge was
added for that holdout.
