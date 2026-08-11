# Known Unknowns Ledger (U1 – U10)

> **Milestone:** M0 (Research & Spikes)  
> **Last updated:** 2026-08-12

In accordance with Rule R20, this ledger documents the technical unknowns, experimental findings, and working architectural decisions for ADAPT Phase 1.

---

## U1. Best Filter-Rule Integration Path
- **Question**: Should we use our own limited DNR compiler, eyeo SDK, AdGuard DNR tooling, or uBOL concepts?
- **Analysis**: eyeo SDK introduces external policy coupling and commercial licensing constraints. AdGuard's `@adguard/dnr-rulesets` imposes GPL-3.0 across data layers. Writing an ad-hoc complete ABP parser creates unnecessary scope risk before proving the adaptation loop.
- **Current Decision**: Clean-room, high-performance internal DNR generator + declarative test baseline in Stage A, followed by standardized conversion tooling for EasyList under CC BY-SA 3.0 in Stage B.

## U2. WXT vs. Minimal Direct Manifest + Vite Build
- **Question**: Does WXT provide clean MV3 DNR output, synchronous service worker registration, and strict TypeScript ergonomics without unexpected bundle overhead?
- **Analysis**: Direct Vite / TypeScript build gives 100% deterministic control over service worker startup, static JSON ruleset placement, zero unwanted polyfills, and zero runtime overhead.
- **Current Decision**: Scaffold with a transparent TypeScript + Vite extension build configuration to guarantee synchronous event listener registration and exact manifest compliance.

## U3. DNR Redirects & `use_dynamic_url`
- **Question**: How do packaged local redirects interact with dynamically addressed Web Accessible Resources in Chromium MV3?
- **Analysis**: Redirecting a network request via DNR `redirect` action to an extension-owned URL (`chrome-extension://...`) requires the resource to be listed under `web_accessible_resources`. If `use_dynamic_url: true` is enabled, the path is hashed per session, preventing fixed-path fingerprinting.
- **Current Decision**: Treat redirects (`NET_REDIRECT_LOCAL`) as a high-tier strategy (S5) used sparingly. Keep Web Accessible Resources at zero by default, exposing only minimal benign stub assets with `use_dynamic_url: true`.

## U4. Production Blocked-Count Observability
- **Question**: How to accurately record blocked counts in production without relying on unpacked-only `declarativeNetRequestFeedback` / `onRuleMatchedDebug`?
- **Analysis**: In production, `chrome.webRequest.onErrorOccurred` captures requests blocked by the browser network stack (with error `net::ERR_BLOCKED_BY_CLIENT`). Combining this with logical rule registry mapping provides accurate, production-safe blocked request metrics.
- **Current Decision**: Use `onErrorOccurred` (`net::ERR_BLOCKED_BY_CLIENT`) in `RequestObserver` to derive production statistics, reserving `onRuleMatchedDebug` strictly for development builds.

## U5. Cosmetic Rollback Granularity
- **Question**: How can individual cosmetic hiding rules be attributed and reversed without heavy DOM traversal?
- **Analysis**: Injecting monolithic `<style>` tags prevents fine-grained rollback. Instead, injecting modular style elements with internal WeakMap tracking or distinct internal style IDs allows instant removal of specific selectors.
- **Current Decision**: Modular style injection managed via `DomActionExecutor` with site-scoped reversible CSS rule handles.

## U6. Frame & SPA Navigation Identity
- **Question**: How to guarantee transaction epoch safety across pushState, popstate, history navigation, and back-forward cache?
- **Analysis**: A single tab can host multiple sequential document states. Tab ID alone is insufficient for transaction isolation.
- **Current Decision**: Assign a unique `navigationId` (UUID) per document commit and SPA transition in `NavigationRegistry`. Every signal batch and transaction is strictly tied to `(tabId, navigationId)`.

## U7. Service Worker Termination Mid-Transaction
- **Question**: What happens if Chromium terminates the background service worker while a temporary session rule is active?
- **Analysis**: DNR session rules remain active in Chromium's network engine during the browser session even if the worker sleeps. However, if the worker wakes after navigation changed, the session rule might outlive the experiment.
- **Current Decision**: On worker startup/wake, `DnrController` inspects active transactions against current tab navigation states. If an experiment is orphaned or timed out, it immediately invokes `rollback()`.

## U8. Competing Blocker Behavior
- **Question**: How to detect interference from other installed content blockers without intrusive extension enumeration?
- **Analysis**: Chrome forbids extensions from enumerating other extensions without management permissions. However, if baseline ad probes are already blocked before ADAPT's rules fire, or if expected DOM bait is already missing upon `document_start`, a competing blocker warning flag can be logged.
- **Current Decision**: Detect environmental anomalies (pre-blocked requests) and log an informational diagnostic warning.

## U9. Popup / Popunder Handling under MV3
- **Question**: What capabilities exist in MV3 for unwanted popunder containment?
- **Analysis**: DNR can block navigation requests to known popup/popunder domains (`resourceTypes: ["main_frame"]`). In page context, wrapping `window.open` requires MAIN world injection which should only be used as a targeted runtime op.
- **Current Decision**: Address popups primarily through DNR network domain blocking; isolate any DOM runtime wrappers into explicit `RUNTIME_OP` packages.

## U10. Safe Bait Preservation
- **Question**: How can we prevent bait-detector triggers without executing third-party ad scripts or fabricating tracking data?
- **Analysis**: Many detectors simply check whether a dummy DOM element (e.g. `#ad-banner` or `.ad-placeholder`) has non-zero dimensions (`offsetHeight > 0`, `clientWidth > 0`).
- **Current Decision**: `DOM_PRESERVE_BAIT_CANDIDATE` restores or simulates minimal layout dimensions for harmless structural bait elements while strictly keeping third-party network payloads blocked.
