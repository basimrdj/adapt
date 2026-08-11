# ADR-005: Privacy Invariants & Adaptation Policy

## Context
When a website deploys anti-adblock mechanisms, naive automated systems might attempt to satisfy the detector by unblocking trackers or advertising scripts. This undermines user privacy.

## Decision
1. **Privacy Precedence**: Privacy protection strictly outranks anti-adblock bypass success.
2. **Strategy Selection Hierarchy**:
   - S1: Roll back cosmetic element hiding (restore hidden element structure).
   - S2: Preserve harmless bait layout dimensions.
   - S3: Remove anti-adblock overlay UI & restore scroll/pointer interactivity.
   - S4: Narrow, safe non-tracking network exception (strictly for benign probes, never for trackers).
   - S5: Local benign resource redirection.
   - S6: Pre-packaged MAIN-world compatibility op.
   - S7: Safe stop & user notification.
3. **Telemetry Invariant**: Zero remote telemetry, zero browsing history collection, aggressive URL query redaction.

## Consequences
- **Positive**: Absolute privacy guarantee; zero silent data leaks to third-party ad networks.
- **Negative**: Certain aggressive paywalls or complex ad-delivery systems that require executing full ad video players cannot and will not be automated (which is explicitly out of scope).
