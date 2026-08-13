# Phase 3.1B Filtering Matrix

| Capability | Implementation | Coverage | Failure behavior |
|---|---|---|---|
| Network block/allow | Existing DNR compiler and shards | Maintained IDs 2, 3, 17, 19, 21, 208 | Invalid or over-quota rules are dropped and reported. |
| Generic cosmetic CSS | `phase31-page-cosmetic.css` | Bounded safe generic selectors | Invalid/unsafe selectors are excluded. |
| Domain cosmetics | `PageFilteringRuntime` | Domain suffix and exclusion matching | Rule is skipped if selector validation fails. |
| Cosmetic exceptions | Typed exception index | Exact selector/domain match | Exception wins over the corresponding page rule. |
| Specific-generic rules | Domain scope plus generic rule records | Parser preserves scope | Unrecognized scope is recorded as unsupported. |
| Extended CSS | `:has-text`, `:matches-css`, `:remove`, `:remove-attr` | Audited subset | XPath, upward, watch-attr, style, and ABP-specific forms are rejected. |
| Scriptlets | Typed descriptors and allowlist | `remove-attr`, `remove-class`, `remove-node-attr`, `remove-node-text`, `set-constant` | Unsupported primitives are counted and never executed. |
| Scriptlet exceptions | Name/argument/domain matching | Supported descriptor set | Exception suppresses matching scriptlet. |
| SPA reinjection | History events plus coalesced MutationObserver | Same document route changes | Bounded rescan; storm mode delays work. |
| Frames | `all_frames` and frame-local runtime | Same-origin and cross-origin injection where Chrome permits | Frame remains isolated; no cross-origin DOM traversal. |
| Shadow DOM | Ordinary DOM plus open-root behavior where surfaced | Open roots only | Closed roots are not claimed. |
