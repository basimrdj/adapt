# ADAPT Phase 2 — Research Ledger

**Date**: 2026-08-12  
**Subject**: Adaptive Intelligence Layer & Azure OpenAI Integration  
**Status**: Authoritative

---

## 1. Azure OpenAI v1 API & Architecture

### API Endpoint & Deployment
- **Endpoint Structure**: `https://basim-agent3-openai-eastus2.openai.azure.com/openai/v1/`
- **Deployment Name**: `buzz-gpt-5-4-mini` (Underlying model: GPT-5.4 mini)
- **Authentication**: Azure Cognitive Services API Key (obtained at runtime via Azure CLI `az cognitiveservices account keys list`; NEVER stored in repository or client bundle).

### Protocol: Chat Completions vs Responses API
- **v1 Chat Completions**: Fully supports Structured Outputs (`response_format: { type: "json_schema", json_schema: { strict: true, schema: ... } }`) and `reasoning_effort`.
- **Stateless Invariant**: We enforce `store: false` or stateless calls. The model maintains no server-side session state; each adaptation hypothesis is derived strictly from the self-contained `EvidencePacket`.

---

## 2. Structured Outputs & Constrained Decoding

- **Mechanism**: Grammar-constrained decoding at the inference level. The model is physically constrained to emit only tokens conforming to the provided JSON Schema.
- **Strict Mode**: Requires `"strict": true`, `"additionalProperties": false` on all object schemas, and all properties explicitly listed in `required`.
- **Safety Benefit**: Eliminates schema hallucinations, ensuring model output can be safely parsed with `JSON.parse` and validated with local TypeScript schema guards before any action is staged.

---

## 3. Reasoning Effort & Resource Budget

- **Supported Values**: `low`, `medium`, `high`.
- **Target Policy**: Use `low` reasoning effort by default.
  - Reason: Web page adaptation must be fast ($< 2000\text{ ms}$). High reasoning effort increases latency and token cost without proportional gains for bounded DSL decisions.
- **Output Token Budget**: Bounded `max_completion_tokens` (e.g. 500–1000 tokens) because the plan schema is compact and requires no conversational prose.

---

## 4. Opaque References & Action DSL

- **Principle**: The model **never** generates arbitrary CSS selectors, XPath expressions, JavaScript code, regex patterns, or URLs.
- **Opaque Reference System**:
  - The `EvidencePacket` generates opaque IDs for candidates: e.g. `element:e1`, `element:e2`, `request:r1`.
  - The model only references these opaque IDs (e.g. `targetRef: "element:e1"`).
  - The `PolicyValidator` resolves opaque IDs back to audited Phase 1 DOM/DNR actions.
- **Prompt Injection Defense**:
  - Webpage text, attributes, and URLs are treated as untrusted adversarial data.
  - Developer instructions explicitly declare that page content is data to classify, not instructions to execute.
  - Even if the model were tricked, it can only pick actions from the pre-audited action DSL and opaque element references present in the packet.

---

## 5. Development Oracle vs Production Isolation

- **Production Extension**:
  - Zero Azure keys, endpoints, or OpenAI SDK dependencies in `dist/`.
  - Production manifest contains zero localhost permissions.
- **Development Oracle (`tools/ai-oracle`)**:
  - Runs locally on `127.0.0.1:<PORT>`.
  - Extension communicates over localhost transport only during active development/evaluation.
  - Generates an ephemeral session token to authenticate requests.
  - Never logs or exposes credentials.

---

## 6. Visual Intelligence (Escalation Only)

- Multimodal input (image cropping) is reserved for ambiguous overlays where text/DOM signals are insufficient (e.g. Canvas overlays, image-based prompt gates).
- Screenshots are tightly cropped to the candidate bounding box (never full-screen uploads) to preserve user privacy and conserve bandwidth/tokens.
