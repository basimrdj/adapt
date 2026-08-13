# Phase 3 M0-M6 implementation verification

Date: 2026-08-13

## Outcome

The Phase 3 modules are now connected to the production background and content entrypoints. The online runtime remains intervention-first and fail-closed. Offline structure discovery is deliberately deferred to M7.

## Remediations

1. Navigation identity
   - Chrome `documentId` is accepted from `webNavigation`, `webRequest`, and `MessageSender`.
   - SPA history increments ADAPT's numeric epoch without changing `documentId`.
   - A runtime message that wakes the worker before `onCommitted` no longer creates a competing synthetic epoch.
   - Slow planner responses and stale request/page messages cause zero mutation.

2. Session recovery
   - Navigation epochs/counters, EventGraphs, Beta beliefs, effect accumulators, and active causal experiments use `chrome.storage.session`.
   - Startup restores state before listeners mutate causal state.
   - STAGED records without commit proof are conservatively rolled back.

3. Safe interventions
   - Element references remain opaque outside the content script.
   - DOM apply and rollback require explicit content-script ACKs.
   - Experiments measure after a bounded settle window and restore DOM/DNR effects even when successful.
   - Blocked-resource observations can form hypotheses, but the online generator abstains because adding a DNR allow after a failed request does not retry it.
   - The former `.invalid` no-op network experiment is rejected.

4. Health and inference
   - Network integrity is derived from request failures; missing telemetry is represented as 0.5, not perfect health.
   - Privacy preservation is carried through experiment evidence and promotion.
   - Success-rate uncertainty uses a Wilson interval; effect uncertainty uses a small-sample Student-t interval.
   - Support requires at least five observations and can accumulate across visits using an origin/mechanism/causal signature key.

5. Recipe operation
   - Supported mechanisms compile to DRAFT recipes.
   - Later visits must match a structural fingerprint; opaque element targets are remapped from current observations.
   - Replays are temporary, ACKed, measured, and rolled back.
   - Failures or identity changes invalidate; path-class mismatches abstain.
   - Promotion derives distinct visits, fingerprint hashes, privacy minima, committed transactions, and rollback proof from stored evidence. Supplied counters alone cannot pass.

## Direct verification

- `npm run typecheck`
- `npm run test:unit`
- `npm run build`
- `tests/e2e/phase3-causal-live.test.ts` in real Chromium:
  - causal graphs and experiment records exist in `chrome.storage.session`;
  - SPA history keeps `documentId` while increasing navigation epoch;
  - full navigation changes `documentId`;
  - forced service-worker execution termination restores session state.

## Remaining proof gate

M7 must compare PC, GES, and FCI on generated ground-truth fixtures and a held-out set. No offline learner may enter the production extension unless it improves held-out hypothesis quality without weakening the online safety gates.
