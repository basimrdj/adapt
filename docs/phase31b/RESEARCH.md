# Phase 3.1B Research Ledger

Access date for the sources below: 2026-08-13. The repository and generated
artifacts remain the source of truth for implementation claims.

## Chromium MV3

| Primary source | Finding | Decision |
|---|---|---|
| https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest | Chrome permits up to 100 declared static rulesets, 50 enabled at once, and guarantees at least 30,000 enabled static rules across an extension. Dynamic rules persist; session rules do not. | Preserve the existing baseline plus capacity-aware optional shards. Do not assume the guaranteed floor equals the live global capacity. |
| https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest | The documented minimum dynamic quota is 5,000, safe dynamic rules can use the larger 30,000 quota introduced in Chrome 121, and regular-expression rules are separately limited to 1,000 per rule class. | Keep causal experiments in the existing bounded DNR controller and reserve page filtering for declarative/package-time data. |
| https://developer.chrome.com/docs/extensions/reference/api/scripting | `registerContentScripts()` and `executeScript()` support explicit content-script registration and execution worlds. | Use the content script as the reliable bootstrap and reserve MAIN-world execution for the single audited `set-constant` primitive. |
| https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts | `document_start`, `all_frames`, and match-pattern behavior define early, frame-scoped injection. | Keep page filtering at document start and all frames, with frame-local state. |
| https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle | Extension service workers normally terminate after 30 seconds of inactivity; long-running requests have a five-minute ceiling. | Baseline page filtering must not depend on a resident worker. The page bundle loads from the content script. |
| https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources | `use_dynamic_url` changes how exposed resources are addressed and is optional. | Keep the existing WAR surface minimal and dynamic where redirects are present. |

## AdGuard

| Primary source | Finding | Decision |
|---|---|---|
| https://github.com/AdguardTeam/tsurlfilter | The monorepo separates parsing, matching, extension integration, DNR conversion, and prebuilt rulesets. | Reuse the conceptual separation, not the GPL runtime implementation. |
| https://github.com/AdguardTeam/tsurlfilter/tree/master/packages/tswebextension | `tswebextension` integrates static filter IDs, custom filters, ruleset paths, content filtering, Extended CSS, and scriptlets for MV3. | ADAPT implements a smaller audited data contract with explicit unsupported-rule accounting instead of importing the runtime. |
| https://raw.githubusercontent.com/AdguardTeam/tsurlfilter/master/LICENSE | The upstream repository is GPLv3. | Do not copy or bundle its runtime into a proprietary ADAPT extension without a separate licensing decision. |
| https://filters.adtidy.org/extension/chromium-mv3/filters/2.txt | The maintained filter endpoint provides the source text and metadata used by the build. | Preserve source IDs, versions, SHA-256 hashes, and provenance in `BUILD-MANIFEST.json`. |

## uBlock Origin Lite

| Primary source | Finding | Decision |
|---|---|---|
| https://github.com/uBlockOrigin/uBOL-home/blob/main/README.md | uBO Lite describes an entirely declarative MV3 design where the browser handles CSS/JS injection and the service worker is not a permanent filtering process. | Make known filtering independent of service-worker liveness and keep AI/causal work off the ordinary page-load path. |
| https://api.github.com/repos/uBlockOrigin/uBOL-home | The repository reports GPL-3.0. | Reference architecture and benchmark target only; no source copied. |

## Resulting boundary

The chosen boundary is: DNR for network decisions, compiled filter data plus
CSS for known page rules, a bounded content runtime for domain/procedural rules,
one narrowly allowlisted MAIN-world primitive, the existing Phase 3 causal
engine for unresolved reactions, and the existing advisory AI cascade only
after evidence and policy validation.
