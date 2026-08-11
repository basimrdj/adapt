# ADR-004: Storage Architecture and State Durability

## Context
Extension service workers terminate frequently (~30s idle). The blocker must store user preferences, learned recipes, rule mappings, and transaction records with high reliability across restarts.

## Decision
1. **Persistent Tier (`chrome.storage.local`)**:
   - Site recipes (`adapt_recipes_v1`)
   - Dynamic rule allocations (`adapt_dnr_dynamic_v1`)
   - User settings & whitelist (`adapt_settings_v1`)
   - Schema version tracking (`adapt_schema_version`)
2. **Ephemeral Session Tier (`chrome.storage.session`)**:
   - Active navigation registries
   - Active experiment transaction state (`adapt_active_txs_v1`)
3. **Repository Abstraction**: All storage operations access data via typed Repository interfaces (`RecipeStore`, `DnrStore`, `AuditStore`), decoupling business logic from underlying Chrome storage primitives.

## Consequences
- **Positive**: Resilient to service worker sleep/wake cycles; clean testing mocks; clear separation of persistent vs session data.
- **Negative**: Asynchronous I/O overhead on worker wakeup (minimized by small payloads and batching).
