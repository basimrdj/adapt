# ADR-010: EvidencePacket Schema & Opaque References

## Context
Raw DOM dumps, URLs with user tokens, form inputs, and browsing history violate privacy invariants and introduce massive prompt injection attack vectors.

## Decision
1. Design `EvidencePacket` as a compact, privacy-sanitized structure containing only geometric ratios, interaction flags, detector confidence, and candidate elements/requests.
2. Index all candidate elements and network requests with opaque references (e.g. `element:e1`, `request:r1`).
3. Explicitly exclude user identifying information, query parameters, cookies, and raw DOM trees.

## Consequences
- **Positive**: Strict user privacy; bounded token usage (< 150 tokens); eliminates raw selector injection.
- **Negative**: Model cannot inspect arbitrarily nested non-candidate DOM elements without sensor escalation.
