# ADR-002: Network Filter Engine & Enforcement Placement

## Context
Manifest V3 removes synchronous `webRequestBlocking` for standard store extensions. Extensions must choose between native Declarative Net Request (DNR) or attempting asynchronous WASM matchers (e.g. Brave `adblock-rust`) which cannot block requests before dispatch.

## Decision
1. **Network Enforcement**: Chromium's native Declarative Net Request (DNR) engine is the sole hot-path blocker. All network rule evaluations occur directly within Chromium's C++ network stack.
2. **Asynchronous Analysis**: `chrome.webRequest` events are used strictly for read-only observation to construct navigation request graphs and detect anti-adblock probe failures.
3. **Filter Pipeline**: Initial development uses clean-room authored DNR baseline rulesets (`src/rules/static/baseline.json`). Full production list conversion (EasyList CC BY-SA 3.0) will be handled by build-time compilation.

## Consequences
- **Positive**: Native speed, zero JS thread blocking during network operations, battery and CPU efficiency.
- **Negative**: Subject to DNR quota constraints and regex complexity limits (managed by strict rule budgeting in `DnrController`).
