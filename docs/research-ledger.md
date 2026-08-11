# ADAPT Research Ledger

> **Milestone:** M0 (Research Re-verification)  
> **Last verified:** 2026-08-12  
> **Target Environment:** Chromium 128+ / Manifest V3

This ledger records every browser API, quota, lifecycle behavior, dependency, and policy constraint verified against primary sources.

---

## 1. Declarative Net Request (DNR)

### 1.1 Core Quotas & Limits
- **Dynamic Rules Cap (`MAX_NUMBER_OF_DYNAMIC_RULES`)**: 30,000 rules.
- **Unsafe Dynamic Rules Cap (`MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES`)**: 5,000 rules (redirects, header modifications).
- **Session Rules Cap (`MAX_NUMBER_OF_SESSION_RULES`)**: 5,000 rules.
- **Static Rulesets**: Up to 100 declared in manifest; up to 50 simultaneously enabled; guaranteed minimum of 30,000 static rules.
- **Regex Rules**: Up to 1,000 regex rules per ruleset class, checked against RE2 complexity constraints.

### 1.2 Scoping & Rule Lifecycle
- **Static Rules**: Defined at build time in manifest JSON files. Immutable at runtime; enable/disable toggles persist across sessions.
- **Dynamic Rules (`updateDynamicRules`)**: Persisted by Chromium across browser restarts and extension updates. Global scope across all tabs.
- **Session Rules (`updateSessionRules`)**: Ephemeral, memory-resident in Chromium. Cleared on browser shutdown or extension reload/update.
- **Tab Scoping**: The `tabIds` condition (`condition.tabIds: [tabId]`) is **only** supported in session rules. This enables tab-isolated experimental mutations without polluting other browsing contexts.
- **Atomic Operations**: `updateDynamicRules` and `updateSessionRules` execute atomically (`removeRuleIds` + `addRules`). If an error occurs (e.g. quota exceeded or invalid regex), no partial changes apply.

### 1.3 Action & Priority Semantics
- **Actions**: `block`, `allow`, `allowAllRequests`, `redirect`, `modifyHeaders`, `upgradeScheme`.
- **Precedence**: Higher numerical priority takes precedence. When rules conflict, higher priority wins.
- **Safe vs Unsafe Actions**:
  - *Safe*: `block`, `allow`, `allowAllRequests`, `upgradeScheme`.
  - *Unsafe*: `redirect`, `modifyHeaders`.

---

## 2. WebRequest & Network Observation

### 2.1 MV3 Observability Scope
- Ordinary store extensions have read-only observation capabilities via `chrome.webRequest` (e.g. `onBeforeRequest`, `onCompleted`, `onErrorOccurred`, `onBeforeSendHeaders`, `onHeadersReceived`).
- Synchronous modification (`webRequestBlocking`) is unavailable in normal MV3 store extensions.
- Observability is used to construct a per-navigation request graph, detect blocked/failed probe resources, and correlate page reactions with network events.

### 2.2 Privacy & URL Normalization
- URLs captured in telemetry are aggressively normalized to `origin + coarse path` (e.g. `https://ads.example.com/lib/ad.js`).
- Query parameters, hash fragments, and tokens are scrubbed before in-memory aggregation or local logging.

---

## 3. Extension Service Worker Lifecycle

### 3.1 Termination & Wakeup
- Extension service workers are event-driven and can be terminated by Chromium after ~30 seconds of inactivity.
- Listeners (`chrome.webNavigation.*`, `chrome.webRequest.*`, `chrome.runtime.onMessage`, `chrome.tabs.*`) must be registered synchronously in the top-level script evaluation during worker startup.
- In-memory state (variables, caches) is destroyed upon termination.

### 3.2 State Reconstruction & Crash Recovery
- Persistent data (recipes, dynamic rule mappings, settings) resides in `chrome.storage.local`.
- Active adaptation transactions must be durably checkpointed so that an unexpected worker termination triggers safe rollback of orphaned session rules on the next wakeup.

---

## 4. Content Script Execution & Worlds

### 4.1 ISOLATED vs MAIN World
- **ISOLATED World (Default)**:
  - Separate JavaScript global context; protects extension secrets and internal logic from page scripts.
  - Shares the DOM with the page; DOM mutations are mutually visible.
  - Content sensor runs here at `run_at: "document_start"`.
- **MAIN World**:
  - Runs directly in the page's execution context.
  - Used strictly for pre-packaged, auditable runtime compatibility operations (`RUNTIME_OP:<id>`).
  - No dynamic code generation or `eval`.

### 4.2 Injection Timing & Frame Coverage
- `all_frames: true`: Injects sensor into main frame and subframes.
- `match_about_blank: true` and `match_origin_as_fallback: true`: Handles dynamic and `about:blank` iframe contexts.
- MutationObserver work is bounded and throttled to prevent performance degradation under mutation storms.

---

## 5. Web Accessible Resources (WAR) & Fingerprinting

- Default configuration: **Zero Web Accessible Resources**.
- WAR exposes extension UUID/paths to page scripts, enabling fingerprinting.
- Local redirect rules (`NET_REDIRECT_LOCAL`) requiring extension resources must use `use_dynamic_url: true` and restrict `matches` to necessary origins.

---

## 6. Chrome Web Store & Remote Code Compliance

- **No Remote Code**: Extensions must package all executable logic within the CRX package.
- **Closed Action Vocabulary**: Adaptation rules are structured declarative data (JSON) interpreted by audited, packaged handlers. No arbitrary JavaScript strings or Turing-complete remote DSLs.

---

## 7. Storage Architecture

- `chrome.storage.local`: Primary persistent storage for site recipes, settings, and rule allocations.
- `chrome.storage.session`: Ephemeral session storage for fast in-memory lookups across worker wakeups within a browser session.
- Schema versioning and migration validation required for all stored objects.
