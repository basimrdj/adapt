# ADR-009: Development AI Oracle Architecture

## Context
Calling cloud LLM APIs directly from the browser extension exposes API keys, introduces CSP complications, and bloats the production bundle with SDK code.

## Decision
1. Create a development-only local HTTP daemon (`tools/ai-oracle/server.ts`) that runs exclusively on `127.0.0.1`.
2. Secure the oracle using ephemeral session bearer tokens, strict payload limits (50KB), and 15s request timeouts.
3. Keep all Azure OpenAI SDK dependencies in `tools/ai-oracle/` outside the extension build path (`src/`).
4. Ensure the production build manifest never requests localhost permissions.

## Consequences
- **Positive**: Complete secret isolation; zero API credentials in browser extension bundle; production extension remains lightweight and secure.
- **Negative**: Development evaluation requires launching the local daemon.
