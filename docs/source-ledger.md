# ADAPT Source Ledger

> **Milestone:** M0 (Research Re-verification)  
> **Last updated:** 2026-08-12

This ledger indexes all primary reference sources consulted during the design and implementation of ADAPT Phase 1.

---

## 1. Chromium & Chrome Extension Platform Documentation

| # | Reference / URL | Key Focus Area | Verified Constraints |
|---|---|---|---|
| 1 | [Declarative Net Request API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) | DNR Rulesets, Quotas, Session Rules | Dynamic cap 30k, session cap 5k, unsafe cap 5k, atomic update methods. |
| 2 | [Content Filtering Guidance](https://developer.chrome.com/docs/extensions/develop/concepts/content-filtering) | Content filtering in MV3 | Combining declarative static/dynamic rules with webRequest observation. |
| 3 | [Extension Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) | Worker termination, event listeners | Synchronous top-level listener registration, crash recovery. |
| 4 | [Content Scripts & Execution Worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) | Isolated vs Main world, injection timing | `document_start` timing, isolated world DOM isolation semantics. |
| 5 | [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting) | Dynamic injection, world targeting | Safe execution in MAIN world with static functions. |
| 6 | [Web Accessible Resources](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources) | Manifest specification & fingerprinting | `use_dynamic_url` usage and zero-WAR default principle. |
| 7 | [MV3 Remote Code Requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) | CWS policy on remote code | Prohibits dynamic evaluation of remote code; requires packaged action handlers. |
| 8 | [Storage and Cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) | chrome.storage vs IndexedDB | Storage quota rules, session storage lifecycle. |
| 9 | [Chrome Web Store Privacy & Permissions](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) | Permission justification | Single-purpose justification for each declared permission. |

---

## 2. Content Blocking Projects & Reference Architectures

| # | Project / Repository | License | Key Architecture Insights |
|---|---|---|---|
| 10 | [uBlock Origin Lite (uBOL)](https://github.com/uBlockOrigin/uBOL-home) | GPL-3.0 | Declarative DNR ruleset partitioning, declarative cosmetic filtering, zero-keepalive design. |
| 11 | [uBlock Origin (uAssets)](https://github.com/uBlockOrigin/uAssets) | GPL-3.0 / CC BY-SA 3.0 | Filter syntax, cosmetic hiding rules, anti-adblock detection patterns. |
| 12 | [AdGuard Browser Extension (MV3)](https://github.com/AdguardTeam/AdguardBrowserExtension) | GPL-3.0 | Production MV3 DNR compilation pipeline, request observation, ruleset refresh mechanisms. |
| 13 | [@adguard/dnr-rulesets](https://www.npmjs.com/package/@adguard/dnr-rulesets) | GPL-3.0 | Pre-compiled DNR ruleset format, rule ID range partitioning. |
| 14 | [Brave adblock-rust](https://github.com/brave/adblock-rust) | MPL-2.0 | High-performance Rust/WASM matcher, cosmetic & network rule simulation. |
| 15 | [eyeo WebExt Ad-Filtering Solution](https://developers.eyeo.com/quickstart-web-extension-ad-filtering-solution) | Proprietary / Mixed | Modular content filtering engine for MV3 with snippet injection. |

---

## 3. Filter List Data Sources & Licenses

| # | Source | License | Usage Notes |
|---|---|---|---|
| 16 | [EasyList Repository](https://easylist.to/pages/licence.html) | Dual: GPL-3.0 or CC BY-SA 3.0 | Standard network & cosmetic filtering rules; requires explicit attribution. |
| 17 | [EasyPrivacy Repository](https://easylist.to/) | Dual: GPL-3.0 or CC BY-SA 3.0 | Tracker domain filtering; used as reference for baseline DNR block rules. |

---

## 4. Academic Research

| # | Paper | Publication / Year | Core Insight Applied |
|---|---|---|---|
| 18 | *CV-Inspector: Towards Automating Detection of Adblock Circumvention* | NDSS 2021 | Differential execution analysis reliably identifies anti-adblock reactions despite obfuscated detector code. |
| 19 | *AutoFR: Automated Filter Rule Generation for Adblocking* | USENIX Security 2023 | Content blocking must be modeled as a joint optimization: maximizing ad suppression while minimizing visual and functional breakage. |
| 20 | *AdVersarial: Perceptual Ad Blocking meets Adversarial Machine Learning* | arXiv 2018 | Visual-only classification is susceptible to adversarial disruption; multi-modal DOM+network scoring is essential. |
