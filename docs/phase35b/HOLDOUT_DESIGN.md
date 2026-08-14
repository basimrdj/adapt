# Real Browser Holdout Design

The evaluator launches randomized local Chromium pages with per-trial opaque
route identifiers and lets the packaged extension observe them through its
actual content sensor, service worker, webRequest listeners, and webNavigation
listeners.

Runtime state receives no scenario enum, required primitive, expected outcome,
or fixture truth. Detection is derived from causal event nodes emitted by the
extension. Resolution is derived from browser-observable page health and target
state. Positive trials include fullscreen reaction/scroll lock and popup
navigation fan-out. Negative controls include legitimate target-blank links
and OAuth-like navigation.

The runner does not close positive popup pages as cleanup before scoring. It
only cleans leftover pages after the browser-observable result is captured.

The final run recorded:

- active trials: 4
- negative controls: 4
- detection: 100%
- resolution: 50%
- false positives: 0%
- worker restart recovery: 100%
- popup unwanted-target recall: 0% on the final run

The evaluator is an internal holdout, not proof against the reserved blind
real-world website. That website remains uninspected and untested.
