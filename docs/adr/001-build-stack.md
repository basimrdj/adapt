# ADR-001: Build Stack & Tooling Selection

## Context
ADAPT is a Manifest V3 extension requiring strict TypeScript compilation, deterministic service worker lifecycle handling, static DNR JSON compilation, isolated-world content script packaging, and headless Chromium E2E testing via Puppeteer/Vitest.

## Decision
1. **Core Runtime**: TypeScript 5.x / strict mode.
2. **Build System**: Vite-based multi-entry bundler + explicit manifest compilation for complete transparency over entrypoints, zero polyfill bloat, and guaranteed synchronous listener registration at top-level service worker evaluation.
3. **UI Layer**: Vanilla TypeScript + lightweight HTML/CSS for popup and diagnostics (no heavy React/Vue runtime in Phase 1).
4. **Test Suite**: Vitest for unit tests; Puppeteer for Chromium headless/headed E2E test laboratory.

## Consequences
- **Positive**: Total control over manifest generation, static rule bundling, minimal bundle size (< 100KB), fast build times (< 1s), zero runtime baggage.
- **Negative**: Manual maintenance of manifest types and entrypoints (mitigated by strict TypeScript schema types).
