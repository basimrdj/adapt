# ADR-007: Synthetic Test Laboratory & Verification Strategy

## Context
Validating an adaptive blocker on live third-party sites introduces flakiness, uncontrollable updates, network instability, and ethical concerns. A deterministic test laboratory is required.

## Decision
1. **Synthetic Test Laboratory (T01 – T25)**:
   - A dedicated multi-scenario test suite hosted on local test HTTP servers mimicking first-party and third-party origins.
   - Covers: network ad blocking (T01), cosmetic hiding (T02), bait-element detectors (T03), blocked-probe detectors (T04), full-screen overlays (T05), delayed detectors (T06), repeated re-insertion (T07), SPA routing (T08), cross-site tab reuse (T09), nested iframes (T10), about:blank (T11), benign consent modals (T12), newsletter modals (T13), functional script breakage recovery (T14), mutation storms (T15), service worker edge cases (T16), popunders (T17), open shadow DOM (T18), closed shadow DOM (T19), fingerprint probes (T20), worker termination mid-experiment (T21), browser restart recipe replay (T22), schema migration (T23), DNR quota boundaries (T24), and adversarial message injection (T25).
2. **Testing Tiers**:
   - **Unit Tests**: Pure domain logic (scoring, health comparison, rule compilers, ID allocators, priority sorters) via Vitest.
   - **Integration / E2E Tests**: Full extension loaded in headless Chromium via Puppeteer.

## Consequences
- **Positive**: 100% reproducible test runs, instant feedback, no external network dependencies in CI.
- **Negative**: Requires maintaining test fixture pages.
