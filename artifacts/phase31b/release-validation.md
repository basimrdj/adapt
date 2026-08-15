# ADAPT Phase 3.1B Release Validation

Date: 2026-08-14

Branch: `feat/phase31b-page-plane`

PR: `#2` — kept open and unmerged

Implementation head: `7063a0081fb5c3ff9df761e7f1368c6b80195261`

## Gate verdict

- `ADAPT_PHASE31_OFFLINE=1 npm run verify:phase31b`: PASS at the implementation head.
- Offline gate composition: 10/10 gates passed.
- GitHub Actions: both workflow runs passed every job.
  - Push run `31790439420`: `typecheck` PASS, `page-unit` PASS, `build-integrity-security` PASS.
  - Pull-request run `31790443075`: `typecheck` PASS, `page-unit` PASS, `build-integrity-security` PASS.
- PR state: open, unmerged; GitHub reports the head as mergeable but the release recommendation below remains NO.

## Exact changed files

Compared with the audited starting SHA `990dd21744cdcce9f2047261dd3dc9062cf0c220`:

- `.github/workflows/phase31b.yml`
- `artifacts/phase31b/adversarial-results.json`
- `artifacts/phase31b/latest.json`
- `artifacts/phase31b/page-filter-benchmark.json`
- `artifacts/phase31b/unsupported-scriptlet-frequency.json`
- `scripts/build-page-filtering.ts`
- `scripts/verify-phase31b-integrity.ts`
- `scripts/verify-phase31b.ts`
- `src/entrypoints/background.ts`
- `src/page/filtering/compiler.ts`
- `src/page/filtering/early-runtime.js`
- `src/page/filtering/runtime.ts`
- `src/page/filtering/types.ts`
- `src/shared/main-scriptlet.ts`
- `tests/e2e/extension-e2e.test.ts`
- `tests/e2e/phase31b-adversarial.test.ts`
- `tests/pages/server.ts`
- `tests/pages/t06-nested-iframes/index.html`
- `tests/pages/t07-shadow-dom/index.html`
- `tests/pages/t20-fingerprint-probe/index.html`
- `tests/pages/t33-csp-heavy-page/index.html`
- `tests/pages/t34-early-race/index.html`
- `tests/unit/page-filter-compiler.test.ts`
- `tests/unit/production-bundle-clean.test.ts`

The local `.commandcode/` directory is scratch state and is intentionally not part of the branch.

## Page-plane coverage

- Cosmetic rules parsed: 68,186.
- Generic selectors: 15,260.
- Domain-specific selectors: 52,926.
- Selector exceptions: 1,617.
- Scriptlet rules parsed: 7,630.
- Fully executable scriptlets: 4,469.
- Fully executable at document start: 2,958.
- Unsupported by primitive name: 2,887.
- Unsupported by arguments: 49.
- Rejected as unsafe: 225.
- Exception-suppressed rules: 0.
- Generic CSS emitted: 13,438 selectors.

## Early plane

- Authoritative mechanism: static manifest `document_start` MAIN-world injection.
- Dynamic `registerEarlyPageScripts()` path: removed.
- Early manifest entries: 338.
- Early JavaScript shards: 338, each registered once.
- Early shard bytes: 3,897,893 bytes in the final local build.
- Packaged early bridge: absent; `dist/page-filtering/early-runtime.js` is rejected by integrity checks.
- Early forms covered by the audited plane include `set-constant`, `abort-current-inline-script`, `abort-on-property-read`, `abort-on-property-write`, `prevent-setTimeout`, `prevent-eval-if`, and applicable `json-prune` rules.
- Race fixture observations in the final offline gate, measured with `performance.now()` from navigation start: MAIN-world detector 67.3 ms, `abort-current-inline-script` 64.8 ms, `abort-on-property-read` 66.8 ms. Each detector observed the filtered environment before ordinary inline-page execution could proceed.
- Static early-shard uniqueness and exactly-once execution tests: PASS.

## Fingerprint security

- Production artifact grep for `__adapt*` markers: PASS, zero matches.
- Production artifact grep for ADAPT-branded page-world error strings: PASS, zero matches.
- Host-page detector enumerating `window`/`globalThis` keys and relevant object descriptors: PASS.
- No extension-specific marker node, XHR property, Window property, prototype property, or persistent page-world bridge remains.

## Indexed bundle and performance

- Monolithic index before: 15,022,819 bytes.
- Indexed startup index after: 440 bytes.
- Indexed page bundle after: 33,716,469 bytes.
- Relevant per-frame data loaded for `www.youtube.com`: 1,765,303 bytes.
- Generic base loaded: 1,833 bytes.
- Relevant domain shards: 163,701 bytes.
- Indexed rules selected: 755.
- Per-frame parse time: 9.97 ms in the final offline-gate run.
- Mutation checks benchmarked: 2,000.
- Mutation benchmark: 0.152667 ms.
- Domain shards: 339.
- Early shards: 338.
- Full 14 MB index parse per frame: no.

The old and new byte figures are intentionally reported separately: the old figure is the monolithic index, while the new figure is the complete indexed page bundle. The acceptance-critical startup comparison is 15,022,819 bytes to 440 bytes, with only relevant shards loaded per frame.

## Adversarial corpus

Authoritative corpus result: 30/30 passed, with no presence-only rows.

- `BLOCKING_PASS`: 22.
- `NEGATIVE_CONTROL_PASS`: 5.
- `LIFECYCLE_PASS`: 3.
- `PRESENCE_ONLY`: 0.

Semantic coverage includes network blocking, generic and domain cosmetic filtering, nested frames, cross-origin frames, open Shadow DOM, CSP-heavy pages, SPA navigation, body replacement, mutation storms, worker restart, and negative controls.

## Test totals

- Typecheck: PASS.
- Page unit suite: 9/9 tests.
- Unit suite: 32 files, 153/153 tests.
- Adversarial E2E suite: 34/34 tests.
- Runtime stability: 1/1 test.
- Full Chromium E2E suite: 8 files, 67/67 tests.
- Bundle/security checks: 3 files, 5/5 tests.
- GitHub Actions: 6/6 check runs successful across the push and pull-request workflow runs.

## Unsupported high-frequency primitives

The maintained-rule frequency report still identifies these highest-impact gaps:

| Primitive | Total rules | Unsupported |
|---|---:|---:|
| `prevent-addEventListener` | 421 | 421 |
| `adjust-setInterval` | 348 | 348 |
| `set-cookie` | 336 | 336 |
| `set-local-storage-item` | 296 | 296 |
| `prevent-element-src-loading` | 213 | 213 |
| `adjust-setTimeout` | 165 | 165 |
| `trusted-set-local-storage-item` | 143 | 143 |
| `trusted-click-element` | 136 | 136 |
| `abort-on-stack-trace` | 130 | 130 |
| `trusted-replace-node-text` | 91 | 91 |
| `set-session-storage-item` | 83 | 83 |
| `prevent-setInterval` | 56 | 56 |
| `trusted-set-cookie` | 55 | 55 |
| `abort-on-property-read` | 368 | 44 |
| `json-prune` | 143 | 22 |

The remaining gaps are explicit compiler coverage, not silently counted as early-capable.

## YouTube and real-world validation

- YouTube result: `NOT OBSERVED`.
- No genuine live ad occurrence was tested, so no claim is made about pre-roll, mid-roll, sponsored cards, playback, seeking, volume, captions, comments, playlists, Shorts, or YouTube SPA behavior.
- Clean-profile comparisons against uBO Lite, AdGuard MV3, and no blocker remain pending.

## Licensing

Status: unresolved release blocker.

The existing AdGuard converter/build path is documented as GPL-3.0-only in installed package metadata, and the repository still has no project `LICENSE` file. No uBO/uBOL or AdGuard runtime source was copied into the new page plane, but that does not clear the existing build-toolchain and filter-data licensing review.

## Merge recommendation

**NO for a proprietary release.** The technical P0 gate is green and the branch is ready for human review, but do not merge or ship until the licensing decision is recorded and genuine clean-profile YouTube validation observes an actual ad occurrence. YouTube remains explicitly unverified.
