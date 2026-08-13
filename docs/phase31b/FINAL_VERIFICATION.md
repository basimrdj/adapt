# Phase 3.1B Final Verification

## Authoritative command

```bash
npm run verify:phase31b
```

The command runs typecheck, the full filter build, page compiler tests,
provenance/integrity checks, unit and Phase 3 regressions, the synthetic
adversarial lab, runtime stability, Chromium E2E, and bundle security checks.
It writes the machine-readable result to `artifacts/phase31b/latest.json` and
returns nonzero on the first failed gate.

## Current evidence

- Baseline before implementation: 140 unit tests passed.
- New page compiler/lab unit coverage: 5 tests passed.
- Build artifact generation produced a page bundle, generic CSS, and a build
  manifest from six maintained filter sources.
- Authoritative verification passed on 2026-08-13 UTC.
- The full gate reported 145 unit tests, 34 Chromium E2E tests across 8 files,
  1 synthetic adversarial lab test, 1 runtime-stability test, 5 page/compiler
  tests, integrity, typecheck, build, and bundle security checks all green.
- The causal acceptance evidence includes a rolled-back scroll experiment,
  a committed bait-preservation experiment, and restart invalidation with zero
  exploration after restart.

## Completion rule

Passing tests do not clear the documented licensing blocker or prove universal
YouTube/anti-adblock behavior. Both remain explicit release decisions.
