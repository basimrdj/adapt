# ADAPT — Privacy Policy

**Effective date: 2026-08-16**

ADAPT — Adaptive Content & Privacy Blocker ("ADAPT", "the extension") is designed privacy-first. This policy describes, completely, what the extension does with your data.

## The short version

- ADAPT collects **no telemetry of any kind**. There is no analytics, no crash reporting, no usage tracking, no "anonymous" statistics.
- ADAPT has **no servers**. Nothing you do is sent to the extension's developer, because there is nothing operated by the developer to receive it.
- All filtering, learning, and adaptation state lives **only in your browser's local extension storage** and never leaves your device, except in the single optional case described below (your own AI provider, which you choose and configure yourself).

## What ADAPT stores locally

To function, ADAPT stores the following **on your device only** (Chrome extension local/session storage):

- Learned per-site adaptation recipes (e.g., which page elements were hidden to neutralize an anti-adblock wall).
- Blocking-rule bookkeeping (rule IDs the extension manages).
- Your settings: paused sites, and — if you configure it — your AI planner connection details.
- A local audit log of adaptation events you can view and clear from the popup.

This data never leaves your browser. Uninstalling the extension removes it.

## Optional bring-your-own-key AI

ADAPT's adaptive engine works fully offline using deterministic logic. Optionally, you may connect an AI planner of **your choice** to improve adaptation on difficult sites:

- You provide the endpoint (any OpenAI-compatible API or Anthropic), the model name, and your own API key in the extension's Settings page.
- Your API key is stored **only** in Chrome's local extension storage on your device. It is transmitted only to the provider endpoint you configured, over HTTPS, exactly like any API client you run yourself.
- When the AI planner is consulted, ADAPT runs in **STRICT privacy mode**: the request contains only opaque, non-identifying evidence — enum labels, numeric health scores, and hashed/opaque element references. It never contains page URLs, hostnames, page content, selectors that could identify you, or any personal data.
- If you never configure an AI provider, no network request of this kind is ever made. The extension ships with **no built-in API key and no default endpoint**.

## Network requests ADAPT makes

1. **Blocking engine:** none. Declarative Net Request rules are compiled into the extension package and evaluated by Chrome locally. Filter lists ship inside the extension; there is no "phone home" list update channel.
2. **Optional AI planner:** only the endpoint you configure, only when you enable it, and subject to a strict per-navigation budget (at most 2 calls per page navigation).
3. **Nothing else.** No update beacons, no remote configuration, no remote code — all logic ships inside the extension package, auditable in full.

## Permissions and why

See `PERMISSIONS.md` for a per-permission justification. In summary, every permission exists to observe page state or apply blocking rules locally; none is used to collect or transmit user data.

## Data sharing

None. There is nothing to share and no one to share it with. If you configure your own AI provider, your relationship with that provider is governed by **their** privacy policy; ADAPT sends them only the opaque STRICT-mode evidence described above.

## Changes

This policy ships inside the extension package (`store/PRIVACY_POLICY.md` in the source repository) and is versioned with the extension. Any change to data practices will appear here before release.

## Contact

Open an issue on the project's public repository.
