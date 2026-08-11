# ADR-003: DNR Rule Lifecycle, Priority Bands, and ID Partitioning

## Context
DNR rules must avoid collisions, handle atomic mutations, manage priority conflicts, and survive extension service worker termination without orphaned rules or quota exhaustion.

## Decision
1. **Rule Ownership**: `DnrController` is the single authoritative module permitted to call `updateDynamicRules`, `updateSessionRules`, or modify rulesets.
2. **Numeric ID Partitioning**:
   - `1_000_000 – 1_999_999`: Learned dynamic safe rules (persistent)
   - `2_000_000 – 2_999_999`: Learned dynamic unsafe rules (persistent redirects/headers)
   - `3_000_000 – 3_999_999`: Experimental session safe rules (ephemeral, tab-scoped)
   - `4_000_000 – 4_999_999`: Experimental session unsafe rules (ephemeral)
3. **Priority Bands**:
   - `10`: Packaged static baseline filters
   - `100`: Persisted learned site blocks
   - `200`: Persisted site compatibility rules
   - `500`: Temporary experiment block rules
   - `600`: Temporary experiment redirect rules
   - `900`: Explicit site compatibility exceptions
   - `1000`: Explicit user allow / trust decisions
4. **Reconciliation**: On service worker startup, `DnrController` syncs actual Chromium rules with the logical database, pruning orphaned experiment rules.

## Consequences
- **Positive**: Deterministic rule tracking, zero ID collisions, predictable conflict resolution, bulletproof crash recovery.
- **Negative**: Requires strict ID bookkeeping in `chrome.storage.local`.
