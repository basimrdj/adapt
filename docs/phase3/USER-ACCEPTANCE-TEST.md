# ADAPT Phase 3 user acceptance test

## One-command verification

From the repository root:

```bash
npm ci
npm run verify:phase3
```

The command runs the canonical typecheck, all unit/property/policy tests, the production build, every real-Chromium suite, a clean-environment M7 benchmark, independent raw-metric recomputation, bundle/security checks, and Graphify portability/structural integrity checks.

In an interactive terminal, the runner then opens `t29-phase3-acceptance` in a fresh Chromium profile and keeps it open until Enter is pressed. In CI or other non-interactive use, set:

```bash
ADAPT_PHASE3_MANUAL=0 npm run verify:phase3
```

## What to observe

The T29 fixture deliberately presents two plausible explanations:

1. an external detector script completed before scroll lock;
2. hidden bait preceded the anti-block overlay.

Expected behavior:

- the safer/high-utility scroll-only discriminator runs first;
- it does not remove the overlay and rolls back;
- scroll-hypothesis confidence falls;
- bait preservation runs next and removes the detector reaction;
- the transaction records positive health change with privacy score `1`;
- repeated independent visits eventually create a draft and two stable replays promote `recipe:rcp1` to `RECIPE_SAFE`;
- a real browser restart retains the recipe and the next matching visit creates zero exploration records;
- `?detector=modified` changes the technical detector signature and invalidates the stale recipe before application.

## Results

The runner writes:

```text
artifacts/phase3/latest.json
artifacts/phase3/latest.md
```

The JSON file is the machine-readable gate result. The Markdown file is the compact human-readable run summary. The detailed verified contract and exact evidence from the final acceptance run are in `docs/phase3/FINAL-ACCEPTANCE-2026-08-13.md`.

Allow roughly five minutes on a warm npm cache. The first clean M7 dependency installation can take longer on a cold network cache.
