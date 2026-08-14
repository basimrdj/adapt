# Worker Restart Evidence

The live probe starts an autonomous popup transaction, waits until pending
state is persisted in `chrome.storage.session`, terminates the extension
service-worker execution through CDP, and waits for the worker to wake and
reconcile the pending state.

The final artifact is
`artifacts/phase35b/WORKER_RESTART_RESULTS.json`.

Final deterministic probe:

- trials: 1
- successful trials: 1
- recovery rate: 100%
- pending autonomy state is persisted before termination
- startup restores the session repositories and reconciles the pending map

This proves the recovery path for the tested transaction shape only. It does
not prove every primitive or every browser termination timing.
