# Phase 3.1B Final Report

Date: 2026-08-13 UTC  
Branch: `feat/phase31b-page-plane`  
PR: #2 remains open and was not merged. No commit or push was created by this run.

## Verification

- Authoritative command: `ADAPT_PHASE31_OFFLINE=1 npm run verify:phase31b`
- Verdict: `PASSED`
- Gate count: 10
- Typecheck: PASS
- Unit: 151/151 tests across 32 files
- Focused page/index tests: 8/8
- Runtime stability: 1/1
- Chromium E2E: 65/65 tests across 8 files
- Bundle security: 4/4
- Package integrity: PASS
- Adversarial corpus: 30/30 executable scenarios

## Coverage

- Cosmetic rules: 68,185
- Exceptions: 1,623
- Scriptlet descriptors: 7,631
- Parsed descriptors including scriptlet exceptions: 7,637
- Fully executable: 4,473
- Unsupported by name: 2,884
- Unsupported by arguments: 49
- Unsafe: 225
- Exception-suppressed: 6

The counts reconcile without optimistic support claims. A descriptor is counted
as fully executable only when its name, complete argument grammar, property path,
execution world, domain scope, and exception behavior pass compiler validation.

## Indexed Page Plane

- Previous monolithic index: 15,022,819 bytes
- New startup index: 412 bytes
- Total page-filtering artifacts: 30,235,251 bytes
- YouTube sample per-frame load: 1,760,804 bytes
- YouTube sample parse: 10.18 ms in the final benchmark run
- Selected indexed rules: 735
- Domain shards: 339
- Early shards: 337
- Mutation lookup: 0.161 ms for 2,000 checks
- Full 14 MB bundle parse per frame: no

Static early registrations use hostname-filtered `include_globs`; this avoids
the Chromium startup failure caused by parsing tens of thousands of host match
patterns while retaining document-start MAIN-world ordering.

## Early Plane

- Race fixture: PASS
- Ordering: the early MAIN-world set-constant is observed before the page's
  extremely early inline detector
- Exact wall-clock script execution timestamp: not instrumented; the acceptance
  assertion is deterministic ordering, not a guessed microsecond measurement

## Unsupported Demand

Generated report: `artifacts/phase31b/unsupported-scriptlet-frequency.json`.
The current maintained corpus has 3,158 unsupported descriptors. Highest demand:

| Primitive | Unsupported | Total | Reason |
|---|---:|---:|---|
| `prevent-addEventListener` | 421 | 421 | unsupported by name |
| `adjust-setInterval` | 348 | 348 | unsupported by name |
| `set-cookie` | 337 | 337 | unsupported by name |
| `set-local-storage-item` | 292 | 292 | unsupported by name |
| `prevent-element-src-loading` | 213 | 213 | unsupported by name |
| `adjust-setTimeout` | 165 | 165 | unsupported by name |
| `trusted-set-local-storage-item` | 143 | 143 | unsupported by name |
| `trusted-click-element` | 136 | 136 | unsupported by name |
| `abort-on-stack-trace` | 130 | 130 | unsupported by name |
| `trusted-replace-node-text` | 91 | 91 | unsupported by name |

Requested high-impact primitives are audited and counted accurately. Current
coverage includes `abort-on-property-read` 324/368, `abort-on-property-write`
142/156, `abort-current-inline-script` 688/697, `prevent-setTimeout` 469/477,
`prevent-eval-if` 39/40, `json-prune` 121/143, and `prevent-window-open` 478/479.
`prevent-fetch` and `prevent-xhr` have no parsed descriptors in the current
maintained corpus, although the audited runtime implementations are present.

## Mutation And Lifecycle

- DOM transformation scriptlets are classified as reapply-on-mutation or
  element-scoped where required.
- SPA navigation and body replacement reapply deterministically.
- Mutation storm handling is coalesced and bounded; no unbounded polling was
  introduced.
- Lifecycle, frame, CSP, shadow DOM, worker restart, and negative-control rows
  are included in the 30/30 corpus artifact.

## YouTube And Real-World Validation

- YouTube: `NOT OBSERVED`
- Pre-roll: not observed
- Mid-roll: not observed
- Playback, seeking, volume, captions, comments, playlists, Shorts, sponsored
  cards, and live SPA behavior: not manually validated
- uBO Lite comparison: pending
- AdGuard MV3 comparison: pending
- No-blocker comparison: pending

No live-site success claim is made. A genuine ad occurrence must be observed on
a clean profile before YouTube can be marked PASS.

## Licensing And Merge Recommendation

The existing AdGuard build/toolchain and related data path remain an explicit
GPL/licensing review blocker for proprietary distribution. No GPL runtime code
was imported to implement the new primitives. The page-plane engineering gate
is green, but the merge recommendation remains **NO for proprietary release**
until licensing is resolved and clean-profile real-world validation is complete.

## Exact Changed Files

- `.github/workflows/phase31b.yml`
- `artifacts/phase31b/FINAL_REPORT.md`
- `artifacts/phase31b/adversarial-results.json`
- `artifacts/phase31b/latest.json`
- `artifacts/phase31b/page-filter-benchmark.json`
- `artifacts/phase31b/unsupported-scriptlet-frequency.json`
- `docs/phase31b/ARCHITECTURE.md`
- `docs/phase31b/FINAL_VERIFICATION.md`
- `docs/phase31b/HANDOFF.md`
- `docs/phase31b/LICENSE_REVIEW.md`
- `docs/phase31b/PERFORMANCE.md`
- `docs/phase31b/REAL_WORLD_VALIDATION.md`
- `package.json`
- `scripts/benchmark-page-filtering.ts`
- `scripts/build-page-filtering.ts`
- `scripts/verify-phase31b-integrity.ts`
- `scripts/verify-phase31b.ts`
- `src/entrypoints/background.ts`
- `src/page/filtering/compiler.ts`
- `src/page/filtering/early-runtime.js`
- `src/page/filtering/runtime.ts`
- `src/page/filtering/types.ts`
- `src/shared/main-scriptlet.ts`
- `tests/e2e/phase31b-adversarial.test.ts`
- `tests/pages/t33-csp-heavy-page/index.html`
- `tests/pages/t34-early-race/index.html`
- `tests/unit/main-scriptlet.test.ts`
- `tests/unit/page-filter-compiler.test.ts`
- `tests/unit/page-filter-index.test.ts`
- `tests/unit/page-filter-lifecycle.test.ts`
