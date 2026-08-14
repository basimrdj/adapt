# Phase 3.1B Final Report

Date: 2026-08-14 UTC
Branch: `feat/phase31b-page-plane`
PR: #2 remains open and was not merged.

## Root cause

CanYouBlockIt's detector bait was excluded from the Phase 3.1B page compiler,
but `tools/phase31/v6.mjs` independently parsed Base-filter `##` rules and
generated `phase31-generic-cosmetic.css`. That legacy `:is(...){display:none!important;}`
stylesheet was the second cosmetic plane, so `.ad-widget` could still collapse
to zero height and make the detector report an ad blocker.

## Exact fix

- Removed `plainSelector`, `genericHide`, `anyException`, Base `##` parsing,
  legacy generic CSS chunking, manifest injection, and selector reporting from
  `tools/phase31/v6.mjs`.
- `v6.mjs` is now network/DNR and redirect-resource compilation only.
- Removed the build-time inline generic-CSS fallback from `scripts/build.ts`
  and the corresponding runtime branch; the page compiler owns the CSS plane.
- Reused `renderGenericCosmeticCss()` as the single page-plane emitter.
- Added `cosmeticOwners: 1` and `cosmeticOwner: phase31b-page-plane` to the
  build manifest and made integrity reject duplicate or undeclared CSS planes.
- Integrity now enumerates all manifest CSS, all production CSS artifacts, and
  detector-sensitive selector rules, including `:is(...)` lists.
- Added deterministic complete-build stealth assertions for the exact `dist`
  manifest and artifact set.
- Updated ordinary blocking fixtures to use `.sponsor-div`; `.ad-slot-wrapper`
  remains a possible detector-bait class and is no longer used as an ordinary
  cosmetic regression target.

## Build outputs

- Manifest content-script CSS: `phase31-page-cosmetic.css` only.
- Generated filtering CSS: `dist/phase31-page-cosmetic.css`.
- Generated UI CSS: `dist/popup/assets/index-WlGjJIoV.css`.
- Legacy `dist/phase31-generic-cosmetic.css`: absent.
- Detector-sensitive maintained cosmetic rules: 2,913 possible, 0 confirmed.
- Generic selectors emitted to the authoritative page CSS: 11,718.
- Single owner reported by build/integrity: `cosmeticOwners: 1`.

## Provenance

The maintained filter corpus contains `.ad-widget` twice in source filter #2:

- `thewindowsclub.com##.ad-widget`
- `##.ad-widget`

Both are classified `POSSIBLE_DETECTOR_BAIT` and recorded in
`dist/phase31/DETECTOR-BAIT-AUDIT.json` with the decision
`NOT_EMITTED_TO_UNCONDITIONAL_COSMETIC_CSS`.

## Verification

- `ADAPT_PHASE31_OFFLINE=1 npm run verify:phase31b`: PASS.
- TypeScript: PASS.
- Unit suite: 154/154 tests across 32 files.
- Full Chromium E2E suite: 69/69 tests across 9 files.
- Adversarial suite: 34/34 tests; 30/30 corpus rows passed.
- Corpus classes: 22 `BLOCKING_PASS`, 5 `NEGATIVE_CONTROL_PASS`, 3
  `LIFECYCLE_PASS`, 0 `PRESENCE_ONLY`.
- Passive stealth acceptance: 9/9 required checks plus 2 negative controls.
- Runtime stability: 1/1.
- Bundle/security checks: 5/5.
- Page breakage regressions: 0 observed.
- Ordinary blocking regressions: 0 observed after separating ordinary fixture
  targets from detector bait.

## Stealth fixture

The local mechanism-equivalent detector executes normally. The bait exists,
retains positive `offsetHeight`, `clientHeight`, and bounding-rect dimensions,
keeps non-hidden computed display/visibility and child structure, survives a
timed re-check and reinsertion, while the synthetic advertising script and
fetch probe remain blocked and no ad content loads.

## Performance

- Indexed startup index: 494 bytes.
- Relevant per-frame load for the YouTube sample: 1,784,162 bytes.
- Relevant page-plane parse: 9.03 ms.
- Mutation benchmark: 0.153291 ms for 2,000 checks.
- Domain shards: 339; early shards: 338.
- Full bundle parse per frame: no.

## Real-world status

- CanYouBlockIt live result: `NOT_OBSERVED`; manual clean-profile validation is
  still required and was intentionally not performed in this run.
- No detector script was hidden, blocked, spoofed, or replaced in the local
  acceptance fixture.
- YouTube live ad result: `NOT_OBSERVED`.
- GitHub Actions: PASS for push run `31798853194` and PR run `31798855777`;
  typecheck, page-unit, and build-integrity-security all passed.

## Release status

Do not merge PR #2. The duplicate cosmetic-plane P0 is removed and the local
technical gate is green, but licensing review and manual CanYouBlockIt/clean-
profile live acceptance remain release blockers.
