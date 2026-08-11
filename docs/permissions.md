# Permissions Justification Matrix

> **Milestone:** M0 (Compliance & Security)  
> **Last updated:** 2026-08-12

In compliance with Chrome Web Store policies, every declared permission in ADAPT has a strictly defined single-purpose justification, documented feature owner, and security boundary.

---

## 1. Core Permissions Matrix

| Permission | Feature Owner | Technical Justification | Data Exposed / Security Boundary |
|---|---|---|---|
| `declarativeNetRequestWithHostAccess` | `DnrController` | Synchronously enforce network blocking, local redirects, and dynamic/session rule updates for ad and tracker URLs matching host permissions. | Does not grant JavaScript access to raw request streams; enforcement is performed entirely within Chromium's network stack. |
| `scripting` | `DomActionExecutor` | Dynamically inject localized cosmetic rollback styles, DOM overlay collapse handlers, and pre-packaged runtime ops into specific tabs/frames. | Restricted to tab/frame IDs actively involved in verified adaptation transactions. |
| `storage` | `RecipeStore`, `DnrController`, `AuditStore` | Persist learned site recipes, dynamic DNR rule ID mappings, user preferences, and local adaptation audit logs. | Sandboxed extension storage (`chrome.storage.local` / `session`). No sensitive browsing history is stored. |
| `webRequest` | `RequestObserver` | Read-only observation of outgoing resource requests and failures to build navigation-scoped request graphs and correlate anti-adblock reactions with blocked probes. | Read-only telemetry. Query parameters and tokens are stripped before in-memory processing. No request bodies are inspected. |
| `webNavigation` | `NavigationRegistry` | Track tab lifecycle, navigation epochs, frame hierarchies, and SPA route changes to prevent cross-document state leaks and stale transaction events. | Standard navigation lifecycle events (`onCommitted`, `onCompleted`, `onErrorOccurred`, `onHistoryStateUpdated`). |

---

## 2. Host Permissions

| Pattern | Justification | Boundary |
|---|---|---|
| `http://*/*`<br>`https://*/*` | Enables Declarative Net Request filtering and content-script sensor injection across standard web browsing contexts. | Excludes privileged surfaces (`chrome://`, Chrome Web Store, file URLs, and extension internal origins). |

---

## 3. Development-Only Permissions

| Permission | Usage | Production Policy |
|---|---|---|
| `declarativeNetRequestFeedback` | Enables `onRuleMatchedDebug` events during local test execution and synthetic test suite validation. | **Excluded from production release builds.** Telemetry in production uses logical rule registry mapping. |

---

## 4. Disallowed / Excluded Permissions

The following permissions are explicitly **excluded** in Phase 1 to minimize security and privacy footprint:
- `cookies`: Not required for ad blocking or adaptation.
- `webRequestBlocking`: Replaced entirely by declarative MV3 DNR.
- `offscreen`: No background DOM or media processing required in Phase 1.
- `userScripts`: All content scripts and operations are pre-packaged.
- `nativeMessaging`: No native daemon required in Phase 1.
