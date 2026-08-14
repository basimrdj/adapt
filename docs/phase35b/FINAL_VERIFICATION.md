# Final Verification

## Gates run

- `npm run typecheck`
- `npm run test:unit`
- `npm run verify:autonomy:live`
- `ADAPT_PHASE31_OFFLINE=1 npm run verify:autonomy`
- existing Phase 3.1B build, integrity, stealth, adversarial, runtime, and
  Chromium E2E suites through `verify:phase31b`

## Results

Targeted unit coverage passed: 39 files and 169 tests. The latest live run
generated all Phase 3.5B artifacts but correctly exited nonzero because the
hard thresholds were not met. The existing full Phase 3.1B verifier also had
three Chromium failures in its final run: the blocked-probe gate, a pointer-lock
navigation timeout, and the derived corpus total.

The live score is not a pass because autonomous resolution was 50%, recipe
replay was 0%, primitive browser-tested coverage was 12.5%, and popup unwanted
target recall was 0% in the final run. False positives were 0 and worker
restart recovery was 100%, but those successes do not override the failed
gates.

Final verdict: **PHASE 3.5B NOT VERIFIED**.
