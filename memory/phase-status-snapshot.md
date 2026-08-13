# ADAPT Phase Status Snapshot (2026-08-12)

| Phase | Commit | Status | Headline |
|-------|--------|--------|----------|
| 1 | `1f0c938` | ✅ Built | Deterministic MV3 core, 28 tests |
| 1.5 | `df964e1` | ✅ GO | 3 Critical + 5 High fixed, 54-test gate, 20-tab stress |
| 2 | `4058103`/`f79420a` | 🟡 Arch complete, AI NOT wired in prod | EvidencePacket, PolicyValidator, dev oracle, ADRs 8-15 |
| 2.5 | `6322b07` | ✅ GO (gate) | 250-case corpus, 105 injection suite, live Azure 96% |
| 3 | working tree | 🟢 M0-M6 implemented and live-wired | Session-persistent graph, bounded interventions, belief updates, operational replay/promotion; M7 pending |

## What "GO" actually means at each gate
- 1.5 GO = deterministic foundation trustworthy to build AI on. REAL.
- 2/2.5 GO = AI *architecture* complete + adversarially safe in dev harness.
  Does NOT mean AI runs in the shipped extension. The extension today is
  deterministic-only (planner not constructed in background.ts).

## Test reality
- 77 unit + E2E tests pass. Security/secrecy claims fully verifiable.
- "100% AI accuracy" = MockPlanner (tautological). Live Azure = 96% (25-case sample).
- Deterministic DNR/quota/rollback/concurrency claims = genuinely strong, real Chromium.

## Current evidence boundary

The production background now wires the Phase 3 online causal loop. Real Chromium
tests directly prove session persistence, document identity behavior, and worker
execution termination recovery. PC/GES/FCI remain absent until M7; no offline
discovery result should be claimed before the held-out comparison report exists.
