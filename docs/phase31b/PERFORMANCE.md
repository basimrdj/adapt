# Phase 3.1B Performance

## Build snapshot

The maintained cache generated 68,185 cosmetic records, 1,860 supported
scriptlet records, 1,623 exceptions, and 8,046 unsupported records on the
2026-08-13 build. The generated page data is intentionally explicit and is
tracked in `dist/phase31/BUILD-MANIFEST.json`.

## Runtime controls

- Generic plain CSS is installed declaratively at document start.
- Runtime work is scheduled once per coalesced mutation window.
- Candidate queries are capped at 500 elements per rule and 800 procedural
  rules per pass.
- Mutation storms enter a temporary delayed mode rather than polling faster.
- No permanent 50ms interval exists.
- Page filtering does not require a resident service worker.

## Measurement status

The authoritative gate runs the synthetic lab, runtime stability suite, and
Chromium E2E tests. A fair uBO Lite/AdGuard MV3/no-blocker benchmark on clean
profiles is not yet complete; no comparative marketing claim should be made.
The current 14 MB uncompressed page bundle is a known optimization target and
should be compacted/indexed before a production-quality release.
