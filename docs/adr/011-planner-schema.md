# ADR-011: Planner Schema & Strict Structured Outputs

## Context
LLM responses containing unconstrained prose or loosely formatted JSON can hallucinate invalid action keys, missing required fields, or unparseable syntax.

## Decision
1. Enforce OpenAI / Azure Structured Outputs (`response_format: { type: "json_schema", json_schema: { strict: true, ... } }`).
2. Require `additionalProperties: false` and explicit `required` arrays across all schema objects.
3. Validate the returned `AdaptationPlan` locally using `PolicyValidator` to ensure references exist in the original `EvidencePacket`.

## Consequences
- **Positive**: 100% schema conformance guaranteed by constrained token decoding; fail-closed validation.
- **Negative**: Schema updates require updating both JSON schema definitions and TypeScript interfaces.
