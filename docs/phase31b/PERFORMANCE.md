# Phase 3.1B Performance

## Build snapshot

The maintained cache generated 68,185 cosmetic records, 4,473 fully executable
scriptlet records, 1,623 exceptions, and 5,432 unsupported records on the
2026-08-13 build. The generated page data is tracked in
`dist/phase31/BUILD-MANIFEST.json` with parsed, executable, unsupported-by-name,
unsupported-by-arguments, unsafe, and exception-suppressed counts.

## Runtime controls

- Generic plain CSS is installed declaratively at document start.
- Runtime work is scheduled once per coalesced mutation window.
- Candidate queries are capped at 500 elements per rule and 800 procedural
  rules per pass.
- Mutation storms enter a temporary delayed mode rather than polling faster.
- No permanent 50ms interval exists.
- Page filtering does not require a resident service worker.

## Indexed artifact benchmark

`npm run benchmark:page` measures the v3 index, generic artifact, selected
hostname shards, parse time, and indexed mutation lookup. The current
YouTube-hostname sample records:

- Previous monolithic index: 15,022,819 bytes.
- New startup index: 412 bytes.
- New total page-filtering artifacts: 30,235,251 bytes.
- Per-frame sample load (`www.youtube.com`): 1,760,804 bytes.
- Per-frame sample parse: 9.6 ms.
- Selected domain rules/scriptlets: 735.
- Indexed mutation lookup: 0.15 ms for 2,000 candidate checks.

These are build-time/index benchmarks, not a claim about live-site CPU usage.

## Measurement status

The authoritative gate runs the synthetic corpus, runtime stability suite,
indexed artifact benchmark, and Chromium E2E tests. A fair
uBO Lite/AdGuard MV3/no-blocker benchmark on clean profiles is not yet
complete; no comparative marketing claim should be made.
