# ADAPT — Permission Justifications (Chrome Web Store review)

Every permission below is exercised locally in the browser. None is used to collect, transmit, or monetize user data. ADAPT has no telemetry and no servers.

## declarativeNetRequest
Core blocking engine. Applies the 188k+ compiled filter rules (static plane) and the extension's learned per-site rules. Also used to implement the user's per-site pause control (a scoped `allowAllRequests` rule while a site is paused) and Protected Transaction Mode (a temporary fail-open allowance during user-initiated sign-in/payment/captcha flows).

## storage
All state is local: learned per-site recipes, blocking-rule bookkeeping, the paused-sites list, user settings (including an optional user-provided AI API key), and the local adaptation audit log. Nothing is synced or transmitted.

## webNavigation
Observes navigation lifecycle events to scope blocking state per tab and per document: learning resets across navigations, protected transactions begin/end on navigation boundaries, and paused sites resume protection when you navigate away.

## tabs
Correlates page signals with the correct tab; reloads a tab when the user pauses or resumes protection on its site (so the pre-paint filtering plane restarts into the new state); the popup reads the active tab's hostname to show per-site status.

## scripting
Injects the pre-paint cosmetic-filtering and adaptation logic into pages at `document_start`, so blocking happens before first paint instead of after a visible flash.

## Host access: `http://*/*`, `https://*/*`
A content blocker must evaluate and filter requests/content on every site the user visits — there is no enumerable subset. Host access is used exclusively for in-browser filtering, per-page learning, and (only if the user configures it) sending STRICT-mode opaque evidence to the user's own chosen AI endpoint. The extension communicates with no developer-operated server.

## Remote code declaration
ADAPT executes **no remote code**. All JavaScript ships inside the extension package. The only outbound requests are (a) none by default, and (b) if the user explicitly configures a bring-your-own-key AI provider: JSON evidence requests to the user's own configured endpoint, which return configuration decisions (structured data), never executable code.
