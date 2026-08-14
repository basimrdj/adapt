# Phase 3.1B Final Report

Date: 2026-08-14 UTC
Branch: `feat/phase31b-page-plane`
PR: #2 remains open and was not merged.

## Root cause

CanYouBlockIt's passive detector bait was being collapsed by maintained cosmetic
rules that rendered generic selectors as `display:none!important`. The specific
failure mode was not a page-visible ADAPT marker or a detector-specific script;
it was ordinary cosmetic filtering changing the bait element's natural layout,
so its measured height became zero.

## Mechanism implemented

- Added typed cosmetic classification: `ORDINARY_COSMETIC`,
  `POSSIBLE_DETECTOR_BAIT`, and `CONFIRMED_DETECTOR_BAIT`.
- Added conservative detector-shaped selector heuristics for exact and
  equivalent bait names; no blanket exemption for all ad-looking selectors.
- Excluded possible/confirmed bait from unconditional static generic CSS and
  runtime cosmetic/procedural hiding. Network/DNR blocking remains unchanged.
- Added audited reversible bait actions: `BAIT_PRESERVE_LAYOUT`,
  `BAIT_RESTORE_VISIBILITY`, `BAIT_DISABLE_COSMETIC_HIDE`,
  `BAIT_PRESERVE_CHILD_STRUCTURE`, with the existing legacy bait action kept as
  a target-scoped compatibility alias.
- Bait actions require content-runtime-owned opaque element refs; selectors are
  rejected by guards, causal remapping, and the DOM executor. The fallback
  candidate generator no longer invents selectors.
- Bait preservation restores natural author layout only when a measured hidden
  state is present. No global geometry, computed-style, XHR, Window, or
  prototype monkey patches were added.
- Added production artifact checks that reject detector bait selectors in static
  cosmetic CSS.

## Verification

- `ADAPT_PHASE31_OFFLINE=1 npm run verify:phase31b`: PASS.
- Typecheck: PASS.
- Unit suite: 154/154 tests across 32 files.
- Full Chromium E2E suite: 69/69 tests across 9 files.
- Existing 30-scenario adversarial corpus: 30/30, with 22
  `BLOCKING_PASS`, 5 `NEGATIVE_CONTROL_PASS`, 3 `LIFECYCLE_PASS`, and 0
  `PRESENCE_ONLY`.
- Passive stealth corpus: 11/11, with 9 blocking checks and 2 negative
  controls. The fixture covers height, `offsetHeight`, `clientHeight`,
  `getBoundingClientRect().height`, computed display/visibility, DOM existence,
  child structure, timed re-checks, reinsertion, blocked network probes, and a
  hybrid detector.
- BlockAdBlock/FuckAdBlock-style local family fixture: PASS; detector code
  executes normally, bait remains believable, the synthetic ad script is
  blocked, and no ad content is visible.
- Page breakage regressions: 0 observed in the 69/69 Chromium suite.
- Ordinary blocking regressions: 0 observed; all prior blocking and negative
  controls remain green.

## Coverage and performance

- Detector-sensitive maintained cosmetic rules identified: 2,913 possible;
  0 confirmed by causal evidence in the maintained corpus.
- Generic cosmetic selectors emitted to static CSS: 11,718.
- Relevant YouTube sample per-frame load: 1,784,162 bytes.
- Relevant page-plane parse: 8.84 ms.
- Mutation benchmark: 0.147 ms for 2,000 checks.
- Full bundle parse per frame: no; indexed startup index remains below 4 KiB.

## Real-world status

- CanYouBlockIt live result: `NOT_OBSERVED`.
- No detector script was blocked, hidden, spoofed, or replaced in the local
  acceptance fixture.
- The final live CanYouBlockIt comparison still requires a manual clean-profile
  run: ADAPT off must report blocker OFF, and ADAPT on must still report blocker
  OFF while ad requests remain blocked and visible ads remain absent.
- YouTube: `NOT_OBSERVED`; no genuine live ad occurrence was tested.

## Release status

Do not merge PR #2. Technical local acceptance is green, but licensing review
and the manual CanYouBlockIt/clean-profile live acceptance remain release gates.
