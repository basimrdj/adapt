# ADAPT forensic trace — exact 3-run protocol (10 minutes)

The `dist/` build in this repo now carries development-only forensic instrumentation.
It does NOT change blocking behavior — it only records counters, gate reasons, and
salted-hash fingerprints into `chrome.storage.session`. No URLs, hostnames, or test
names are recorded.

## 1. Load the instrumented build

1. Open a Chrome profile you can use for testing (a fresh one is fine).
2. Go to `chrome://extensions`, enable **Developer mode**.
3. If an older ADAPT build is loaded, remove it.
4. **Load unpacked** → select `/Users/basimhussain/Projects/adapt/dist`.
5. On the ADAPT card, click the **Service worker** link — this opens the worker's
   DevTools console. Keep that console available; you will need it at the end.

## 2. Pre-run settle

Wait ~10 seconds after load (static ruleset reconciliation runs once). Do not reload
the extension at any point during the three runs.

## 3. The three runs

- **RUN 1** — run the external blocker test exactly as you did before.
- Wait **5–10 seconds**.
- **RUN 2** — run the same test again.
- Wait **60 seconds** this time. (This idle window lets the MV3 service worker
  terminate naturally; Run 3 then proves whether learned protections survive a
  worker restart — a key open question. Do not close the browser tab or window.)
- **RUN 3** — run the same test a third time.

Do not reset anything between runs. Do not inspect the tester's internals — just use
it normally, as before.

## 4. Export the trace (same browser session, before closing Chrome)

In the **service worker DevTools console** (from step 1.5 — if it says the worker is
inactive, click the link again to wake it), paste this one command and press Enter:

```js
copy(JSON.stringify({
  aiConfigured: Boolean((await chrome.storage.local.get('adapt_ai_config')).adapt_ai_config),
  forensics: (await chrome.storage.session.get('adapt_kimi_forensics_v1')).adapt_kimi_forensics_v1 ?? null,
  survivorTrace: (await chrome.storage.session.get('adapt_survivor_ai_trace')).adapt_survivor_ai_trace ?? []
}, null, 2))
```

The JSON is now on your clipboard. Save it as
`artifacts/kimi-forensics/RUNTIME_LOOP_TRACE.json` and hand it back.

`aiConfigured` is a boolean only — no endpoint or credential value is exported.

## What this captures

- Every stage of the adaptive funnel per run (requests observed → third-party →
  eligible candidates → survivors → AI gate decision with reason codes → AI calls →
  policy → executor → session-rule installs/removals with call-site attribution).
- Whether any AI planner was configured at all in this profile.
- Whether learned session DNR rules were still present in Chrome before Runs 2/3
  (queried from Chrome itself, not from ADAPT's own state).
- Whether any learned rule actually matched a later request
  (`chrome.declarativeNetRequest.testMatchOutcome`, unpacked-build only).
- Every service-worker restart (`SW_START`) and every startup reconcile that removed
  learned rules (`RECONCILE_RESULT`).
