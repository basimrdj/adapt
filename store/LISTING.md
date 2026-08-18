# ADAPT — Chrome Web Store Listing

## Name
ADAPT — Adaptive Content & Privacy Blocker

## Category
Productivity  (secondary fit: Developer Tools is **not** appropriate; Privacy & Security is the discovery context — list under Productivity per CWS taxonomy, with privacy keywords in the description)

## Short description (≤132 chars, manifest description)
MV3 content blocker with a transactional adaptation engine and optional bring-your-own-key AI (OpenAI-compatible or Anthropic).

## Full description

**ADAPT blocks ads, trackers, and anti-adblock walls — and learns how each site fights back, so it can adapt.**

Most blockers apply the same static lists everywhere and hope. ADAPT adds a second layer: a transactional adaptation engine that observes how a page reacts to blocking, stages a minimal counter-response as a reversible transaction, measures whether page health actually improved, and rolls back instantly if it didn't. What works becomes a per-site recipe that loads before first paint on your next visit. What doesn't work is never kept.

**What's in the box**

- **Static plane** — 188,000+ compiled network and cosmetic rules (EasyList/EasyPrivacy-family sources), evaluated locally by Chrome's Declarative Net Request engine. Zero network fetches, zero update beacons.
- **Adaptive engine** — survives anti-adblock walls, bait elements, and re-hide wars by treating every intervention as a measured, reversible experiment. Protected Transaction Mode automatically fails open during sign-in, payment, and captcha flows so checkouts and logins never break.
- **Optional AI planner, your keys** — connect any OpenAI-compatible endpoint or Anthropic (any provider, any model — OpenAI, OpenRouter, Groq, xAI, a local LM Studio server, …) to sharpen adaptation on difficult sites. STRICT privacy mode: the planner receives only opaque labels, health scores, and hashed references — never URLs, hostnames, or page content. No key configured = no AI traffic at all; the extension ships with no built-in endpoint.
- **Per-site pause** — one click in the popup stands protection down on a site you trust; one click resumes it. Persists across restarts.
- **Privacy by construction** — no telemetry, no analytics, no servers operated by the developer, no remote code. Everything is stored locally and auditable in the extension package.

**Who it's for**

People who want uBlock-grade static blocking plus an engine that handles the sites that detect and punish blockers — without handing their browsing data to anyone.

## Screenshots (1280×800)

1. `screenshot-popup.png` — the popup over a live page: protection status, live pill, per-site pause.
2. `screenshot-popup-paused.png` — paused state: honest "Protection Paused" with one-click resume.
3. `screenshot-options.png` — Settings: bring-your-own-key AI planner (OpenAI-compatible / Anthropic presets), privacy mode, adaptive memory, diagnostics.

## Single-purpose statement
ADAPT is a content and privacy blocker. Every feature — static rules, adaptive transactions, the optional AI planner, pause control — exists to block unwanted content on web pages while preserving page function.

## Privacy practice disclosures (CWS form)
- Collects or transmits user data: **No** (the optional AI planner sends opaque, non-identifying evidence to a user-configured endpoint only when the user enables it; disclosed in the privacy policy).
- Handles personally identifiable information: No.  • Health/financial/location data: No.  • Authentication data: user-stored own API key, local only.  • Personal communications / browsing history: No.  • Web history used for filtering locally, never transmitted: disclosed.
- Remote code use: **No.**
