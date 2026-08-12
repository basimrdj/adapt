# ADAPT Phase 2 — Source Ledger

**Date**: 2026-08-12  
**Subject**: Primary Documentation & Specifications for Phase 2 Architecture

---

## Primary Sources Consulted

1. **Microsoft Learn — Azure OpenAI Service Reference (2025–2026)**
   - [Azure OpenAI Service REST API reference](https://learn.microsoft.com/en-us/azure/ai-services/openai/reference)
   - [How to use Structured Outputs with Azure OpenAI](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/structured-outputs)
   - *Key verified takeaway*: `strict: true` JSON schema support in `/openai/v1` compatibility mode.

2. **OpenAI Official Documentation — Structured Outputs & Reasoning**
   - [OpenAI Structured Outputs Guide](https://platform.openai.com/docs/guides/structured-outputs)
   - [Reasoning Models & Reasoning Effort](https://platform.openai.com/docs/guides/reasoning)
   - *Key verified takeaway*: `reasoning_effort` accepts `low`, `medium`, `high`. Grammar constraints eliminate syntax errors.

3. **Chromium Extension Manifest V3 Security Architecture**
   - [Chrome Extensions Security Model](https://developer.chrome.com/docs/extensions/mv3/security/)
   - [Content Security Policy & Localhost Communication](https://developer.chrome.com/docs/extensions/mv3/intro/mv3-overview/)
   - *Key verified takeaway*: Production extensions must not bundle development API keys; localhost transport must be strictly gated.

4. **Prompt Injection & Indirect Injection Mitigations**
   - [OWASP Top 10 for Large Language Model Applications (LLM01: Prompt Injection)](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
   - *Key verified takeaway*: Treat all external DOM/web content as untrusted data inputs and bound model outputs to opaque referential DSLs.
