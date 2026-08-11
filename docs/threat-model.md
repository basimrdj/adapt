# ADAPT Threat Model & Security Boundaries

> **Milestone:** M0 (Security & Threat Modeling)  
> **Last updated:** 2026-08-12

---

## 1. Adversary Analysis

### Adversary A: Traditional Ad & Tracking Networks
- **Goal**: Deliver behavioral tracking beacons, third-party tracking cookies, and obtrusive advertisement payloads.
- **Threat Vector**: Direct and subframe network requests, CNAME cloaking, WebSocket probes.
- **ADAPT Defense**: Native Chromium Declarative Net Request (DNR) static and dynamic rules.

### Adversary B: Anti-Adblock Reaction Scripts
- **Goal**: Detect ad blocker presence (via missing bait elements, blocked probe scripts, or CSS rule detection) and deploy gating mechanisms (full-screen overlays, scroll locks, disabled navigation, removed players).
- **Threat Vector**: DOM inspection, timer checks, error listeners.
- **ADAPT Defense**: Multidimensional Page Health Engine + Transactional Adaptation Engine (cosmetic rollback, bait preservation, overlay removal, scroll restoration).

### Adversary C: Hostile / Adversarial Web Pages
- **Goal**: Exploit content script execution, attempt extension fingerprinting via Web Accessible Resources or DOM markers, flood MutationObservers with DOM noise to induce browser jank, or send malformed IPC messages to the extension worker.
- **Threat Vector**: Rapid DOM mutations (mutation storms), probing known extension URLs, crafting malicious message events.
- **ADAPT Defense**:
  - ISOLATED world execution by default.
  - Zero Web Accessible Resources by default.
  - Strict MutationObserver rate-limiting, batching, and degradation tiers (`NORMAL` → `COALESCED` → `SAMPLING` → `PAUSED`).
  - Strict runtime schema validation on all message payloads between content script and background worker.

### Adversary D: Compromised / Malicious Filter Sources
- **Goal**: Inject malicious rules, broad allow-rules, or invalid regex patterns.
- **Threat Vector**: Filter list distribution attacks.
- **ADAPT Defense**: Pinned static rulesets with build-time cryptographic hashes and schema validation before deployment.

### Adversary E: Unintended Adaptation Regressions
- **Goal**: (Accidental) A proposed adaptation breaks legitimate site functionality, leaks private tracking, or gets stuck in an infinite retry loop.
- **Threat Vector**: Faulty heuristic decisions.
- **ADAPT Defense**:
  - Strict privacy invariants: Never auto-allow known tracking domains.
  - Multidimensional Health Vector check: Breakage on content availability or interaction fails the transaction.
  - Guaranteed transactional rollback and recipe degradation quarantine.

---

## 2. Core Security Invariants

1. **Untrusted DOM Input**: Treat all DOM elements, attribute strings, and page events as hostile.
2. **Schema-Validated Messaging**: All inter-context messages (`content.ts` ↔ `background.ts`) must pass explicit runtime type validation.
3. **No Executable Code Evaluation**: No `eval()`, `new Function()`, or dynamic script generation.
4. **No Remote Code**: All action handlers are compiled into the extension bundle.
5. **No Extension Secrets in DOM**: Never write internal authentication keys, UUIDs, or debug state into the page DOM.
