# ADAPT Phase 3.1 — Production Blocking Stabilization

Phase 3.1 places a maintained wide-spectrum native DNR substrate underneath the
verified Phase 3 causal/adaptive control loop.

## Runtime safety

- Every `getComputedStyle` and geometry read in the page sensor goes through a
  fail-closed DOM boundary.
- Sensor extractors are independently contained so a hostile/transient DOM state
  cannot crash `content.js`.
- `chrome.runtime.sendMessage()` promise rejections are consumed during service
  worker restart/extension reload.
- Opaque element refs prune disconnected DOM nodes to avoid long-lived SPA
  retention.
- Mutation observation re-attaches after early document-start and now records
  bounded anti-block-like remove/reinsert cycles.

## Production network layer

`npm run build:full`:

1. builds the verified extension;
2. atomically refreshes maintained filter text with a validated-cache fallback;
3. generates packaged redirect/scriptlet resources;
4. compiles curated filter families into Chromium DNR with the official AdGuard
   converter;
5. preserves `ruleset_baseline`;
6. enables only the Base list in the manifest so the artifact fits Chromium's
   guaranteed static-rule baseline;
7. emits a catalog that lets the service worker greedily enable optional
   Tracking / URL tracking / anti-adblock / popup / annoyance / malicious sets
   only when live static-rule capacity allows;
8. generates conservative generic cosmetic CSS from the Base list, dropping any
   generic selector that has a site-specific exception anywhere in the source
   list.

## Debugging

`npm run build:debug` emits an unminified content bundle with source maps.

## Verification

Run:

```bash
npm run typecheck
npm run build:full
npm run test:unit
npm run test:runtime
npm run test:e2e
```

The runtime regression specifically exercises body replacement, text/comment
node churn, and anti-block-like overlay reinsertion while watching Chromium's
runtime exception stream.
