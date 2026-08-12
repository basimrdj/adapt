# ADR-014: Vision Escalation Policy

## Context
Visual multimodal models allow evaluating rendered appearance, but sending full screenshots wastes tokens, increases latency, and risks leaking user browsing content.

## Decision
1. Vision is strictly an **escalation-only** capability, triggered only when DOM and network evidence yield low confidence ($< 0.40$).
2. Only tightly cropped bounding boxes around candidate elements (e.g. suspicious modal or canvas gate) may be captured and transmitted.
3. Full-page viewport screenshots are forbidden by default.

## Consequences
- **Positive**: Preserves user privacy; conserves image token bandwidth; provides visual verification when DOM attributes are obfuscated.
- **Negative**: Canvas-only anti-adblock gates require cropping logic in the content script.
