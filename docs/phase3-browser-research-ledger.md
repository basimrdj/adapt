# Phase 3 Browser-API Research Ledger

> **Milestone:** M0 — Re-verify Chromium/MV3 assumptions before coding.
> **Spec ref:** `ADAPT_Phase_3_Causal_Intelligence_Research_Spec.md` §40 R1, §41.
> **Access date:** 2026-08-12. **Primary sources:** developer.chrome.com / W3C.
> **Format (per R1):** source URL · access date · Chrome milestone · constraint · spike · result · architecture impact.

---

## VERDICT UP FRONT

All four architecture-critical Phase 3 assumptions are **CONFIRMED** against current
primary documentation. The single most important finding: **`documentId` is real,
stable, and exactly what Phase 3's causal identity key needs** — Phase 1's
`navigationId`-only epoch is insufficient and MUST be extended. One refinement
surfaced: **`tabIds` is valid ONLY on session rules, not dynamic rules** — Phase 3
experiments must therefore remain session-scoped (which Phase 1 already does).

---

## F1 — `webNavigation.documentId` (ARCHITECTURE-CRITICAL) ✅ CONFIRMED

| Field | Value |
|---|---|
| Source | https://developer.chrome.com/docs/extensions/reference/api/webNavigation |
| Access date | 2026-08-12 |
| Chrome milestone | documentId introduced **Chrome 106+** |
| Availability | `onCommitted`, `onBeforeNavigate`, `onHistoryStateUpdated`, `onCompleted`, `onErrorOccurred`, `onDOMContentLoaded`, `onTabReplaced` |
| Constraint | `documentId` is a per-document UUID. **Changes when a frame navigates to a new document.** Stable across prerender → active → cached lifecycle states of the *same* document. |
| `frameId` | Identifies the frame *container*, not the content. Main frame = 0. **Reused across navigations** — "difficult to associate something in a specific document with frameIds." |
| `processId` | **Deprecated** (Chrome 49/50). Always -1 in onBeforeNavigate/onErrorOccurred. Not a valid causal identity. |

**Result:** Phase 3's causal key `CausalDocumentKey = { tabId, navigationEpoch, documentId, frameId }` is correct and necessary. `documentId` disambiguates documents that share a reused `frameId`; `navigationEpoch` (ADAPT-assigned, monotonic) disambiguates SPA/`onHistoryStateUpdated` route changes that do NOT change the document; `tabId` scopes to the user tab. `processId` must NEVER be used (spec §4.3 mandate confirmed).

**Architecture impact:** `src/core/navigation/{registry,epoch}.ts` (Phase 1) MUST be extended to capture and propagate `documentId` alongside the existing `navigationId`. The existing `NavigationEpoch` type gains a `documentId: string` field. `webNavigation.onCommitted` handler in `background.ts` already fires; it must record `details.documentId`.

**Empirical spike — PASSED (2026-08-12, real Chromium):** `tools/spikes/document-id-spike.ts` loads a throwaway instrumented extension and captures 10 `webNavigation` events across: load page A → SPA `history.pushState` → navigate to page B. All four properties hold:
- S1 PASS — `documentId` present & non-empty on every main-frame `onCommitted` (3/3).
- S2 PASS — `documentId` **changes** A→B (`25E5B926…` → `413B7D66…`).
- S3 PASS — `documentId` **stable** across SPA `pushState` (spa = A = `25E5B926…`).
- S4 PASS — `frameId` stays `0` across both navigations (reused) → proves `documentId` is necessary.

Result: the Phase 3 causal key `{tabId, navigationEpoch, documentId, frameId}` is **empirically sound**, not just documented.

---

## F2 — MV3 Service-Worker Lifecycle ✅ CONFIRMED

| Field | Value |
|---|---|
| Source | https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle |
| Access date | 2026-08-12 |
| Chrome milestone | Rules as documented apply from **Chrome 120+** |
| Idle termination | **30 seconds** of inactivity. Any event or extension API call resets the 30s timer. A `fetch()` response taking >30s terminates the worker. |
| Hard cap | **5 minutes** for continuous processing of a single request. Some user-prompt APIs are exempt. |
| Keepalive | Long-lived messaging (`runtime.connect` port) keeps the worker alive. Merely opening a port no longer resets inactivity timers. |
| State loss | **All global variables are lost** on worker shutdown. Must use `chrome.storage` / IndexedDB. |

**Result:** Phase 1's design — persisting `activeTransactions` to `chrome.storage.local` with an idempotent `init()` + `reconcile()` on wake — is the correct and only safe pattern. Confirmed in Phase 1.5 (SW-death scenarios pass).

**Architecture impact:** Phase 3 causal state (active EventGraphs, staged experiments, belief posteriors, rollback metadata) MUST live in `chrome.storage.session` (persists across SW restarts within a browser session) or `chrome.storage.local` (survives browser restart). In-memory-only causal state is forbidden. The spec §33 persistence model is validated. **Budget: do NOT keep the worker alive solely for causal analysis** (spec §34) — let it sleep; reconcile on wake.

---

## F3 — DNR Quotas & `tabIds` Scoping ✅ CONFIRMED (with one refinement)

| Field | Value |
|---|---|
| Source | https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest |
| Access date | 2026-08-12 |
| Chrome milestone | Quotas as stated require **Chrome 120+** (pre-120: 5000 combined dynamic+session) |
| `MAX_NUMBER_OF_DYNAMIC_RULES` | **30,000** |
| `MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES` | **5,000** — and these **count toward the 30,000 total** (subset, not independent). |
| `MAX_NUMBER_OF_SESSION_RULES` | **5,000** |
| `MAX_NUMBER_OF_REGEX_RULES` | **1,000** per ruleset type |
| `tabIds` / `excludedTabIds` condition | **Session-scoped rules ONLY.** Cannot be used on dynamic rules. |

**Result:** Phase 1's `DnrQuotaTracker` model is exactly correct (total dynamic ≤30k, unsafe subset ≤5k, session ≤5k, regex ≤1k). Verified empirically in Phase 1.5 quota tests.

**Architecture impact — REFINEMENT:** Because `tabIds` is valid ONLY on session rules, **every per-tab causal network experiment MUST be a session rule** (never a dynamic rule). Phase 1 already enforces this (`addSessionExperimentRules` always sets `tabId`; `persistLearnedRules` for dynamic rules never sets `tabId`). Phase 3 experiments reuse `addSessionExperimentRules` and inherit this correctness for free. A promoted `CausalRecipe` becomes a global dynamic rule (no `tabId`) — correct, since it must apply to future visits in any tab.

---

## F4 — `chrome.storage.session` ✅ CONFIRMED

| Field | Value |
|---|---|
| Source | https://developer.chrome.com/docs/extensions/reference/api/storage |
| Access date | 2026-08-12 |
| Chrome milestone | session area since **Chrome 102**; 10MB quota since Chrome 112 (was 1MB in Chrome 111 and earlier) |
| Persistence | **In-memory only.** Cleared when extension is disabled/reloaded/updated AND when the browser restarts. **Survives service-worker restarts** within an active browser session. |
| Quota | **10,485,760 bytes (10 MB).** |
| Content-script access | **NOT exposed by default.** Requires explicit `chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })`. |

**Result:** Ideal for Phase 3's ephemeral per-document causal state (active graphs, staged experiments, rollback metadata, epoch counters). Survives SW death (the F2 risk) but auto-clears on browser restart — exactly the "document-scoped, not permanent" semantics the spec §33 wants. 10MB is ample for compact graphs (bounded nodes per epoch).

**Architecture impact:** Phase 3 durable state (confirmed `CausalRecipe`s, calibration metadata) goes to `chrome.storage.local` (or IndexedDB for larger structured sets). Active/transient causal state goes to `chrome.storage.session`. The content-script causal sensor does NOT read storage directly — it IPCs observations to the SW (the default `TRUSTED_CONTEXTS` access level is correct; do not widen it).

---

## F5 — Performance / Resource Timing (TO BE VERIFIED at M2) ⏳

**Status:** Not yet re-verified from primary source. Lower urgency — informs the
content-script causal sensor (resource-timing features) and cross-origin timing
restrictions, not the core causal identity model.

**Plan:** Verify against https://www.w3.org/TR/resource-timing/ at M2 (when the
causal sensor is designed). Key questions: Timing-Allow-Origin cross-origin
buffering restrictions, `performance.timeOrigin` as a separate clock domain (spec
§5), buffer-size eviction behavior. **Clock-domain model (spec §5) is
architecturally validated by F1/F2 already** — never subtract timestamps across
clock domains; join on `requestId`/`documentId`/transactionId instead.

---

## F6 — `chrome.debugger` / CDP (TO BE VERIFIED at M7) ⏳

**Status:** Lab-only, not architecture-critical for M1-M6. Verify at M7 when the
offline causal-lab ground-truth harness is built. Spec §4.2 / §2.2 already
mandate: **CDP is lab ground-truth only, NEVER a production dependency.** This is
a hard release blocker (spec §41).

---

## CROSS-CUTTING CONCLUSIONS

1. **The causal identity key is sound.** `tabId + navigationEpoch + documentId + frameId` is the correct quad; all four are available, stable where needed, and `processId` is correctly excluded.
2. **Phase 1's safety architecture transfers cleanly.** DNR quotas, SW-death persistence, tab-scoped session experiments, and reconciliation all remain authoritative for Phase 3.
3. **Two Phase 1 extensions required before M1:**
   - `NavigationEpoch` + `webNavigation` handlers must capture `documentId`.
   - Phase 3 causal state must persist to `storage.session` (active) / `storage.local` (durable).
4. **No new production cloud/CDP dependency** is introduced by any verified fact.

## REMAINING M0 ITEMS (deferred, non-blocking for M1)
- F5 Resource Timing (M2), F6 chrome.debugger (M7), MutationObserver perf patterns (M2 sensor design).

## SOURCES
- webNavigation: https://developer.chrome.com/docs/extensions/reference/api/webNavigation (2026-08-12, Chrome 106+ for documentId)
- SW lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle (2026-08-12, Chrome 120+)
- declarativeNetRequest: https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest (2026-08-12, Chrome 120+)
- storage: https://developer.chrome.com/docs/extensions/reference/api/storage (2026-08-12, Chrome 102/112+)
