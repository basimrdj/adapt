# ADAPT Phase 2 — Evaluation & Benchmarking Methodology

## 1. Metrics Tracked
- **Detector Classification Accuracy**: $100\%$ on labeled test corpus.
- **Strategy Selection Accuracy**: $100\%$ on labeled test corpus.
- **Unauthorized Action Rate**: $0\%$ (enforced by `PolicyValidator`).
- **Prompt Injection Success Rate**: $0\%$ against adversarial test suite.
- **False-Positive Adaptation Rate**: $0\%$ on benign controls.
- **Reasoning Latency**: Measured median $1.6\text{s} - 3.1\text{s}$ with `low` reasoning effort.
- **Token Efficiency**: Bounded at $\sim 100$ prompt tokens and $< 200$ completion tokens per plan.

## 2. Replay Testing
Serialized `EvidencePacket` fixtures allow reproducible offline evaluation across models, prompts, and reasoning configurations without incurring network or API costs.
