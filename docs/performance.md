# ADAPT Performance Engineering & Budgets

> **Milestone:** M0 (Performance & Benchmarks)  
> **Last updated:** 2026-08-12

---

## 1. Performance Philosophy: Zero-Jank Content Blocking

ADAPT must maintain the speed and responsiveness of native declarative filtering.

### Fundamental Rule
**No heavy parsers, no AI inference, and no synchronous DOM traversals in the hot path.**
Network blocking is handled directly by Chromium's native C++ Declarative Net Request engine.

---

## 2. Engineering Budgets & Targets

| Component | Target Metric | Strict Cap / Threshold | Rationale |
|---|---|---|---|
| **Content Sensor (`document_start`)** | < 2 ms (p50), < 5 ms (p95) | < 10 ms | Must not delay initial DOM parsing or block main thread execution. |
| **MutationObserver Budget** | < 5 ms work per 100 ms batch | 20 ms batch ceiling | Prevents frame drops during heavy animations or dynamic DOM insertions. |
| **Mutation Pipeline Throttling** | Normal mode: < 100 mut/sec | > 500 mut/sec triggers degradation | Automatically degrades from full tracking to batched sampling under DOM storms. |
| **Background Worker Wakeup** | < 15 ms execution per event | < 50 ms | Service worker should process events asynchronously and return to idle. |
| **Memory Footprint (Worker)** | < 30 MB idle | < 60 MB peak during adaptation | Keeps background memory overhead negligible. |
| **Memory Footprint (Content Script)** | < 2 MB per frame | < 5 MB per frame | Keeps multi-tab memory consumption minimal. |

---

## 3. Degradation Strategy: Mutation Storm Handling

Under extreme DOM churn (e.g. infinite scroll, heavy video chats, games, or deliberate adversarial DOM floods):

1. **NORMAL**: Standard debounced observation (50 ms batch window).
2. **COALESCED**: Increases debounce window to 200 ms and limits subtree queries to direct parent nodes.
3. **SAMPLING**: Skips micro-mutations and samples DOM state on idle callbacks (`requestIdleCallback`).
4. **PAUSED / RECOVER**: Suspends MutationObserver for 2 seconds, then takes a single lightweight geometry snapshot.

This guarantees the blocker never introduces more overhead than the ads it suppresses.
