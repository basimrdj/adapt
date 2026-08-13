# ADAPT M7 offline causal discovery lab

This lab compares PC, GES, and FCI on synthetic browser-mechanism structural
causal models with known ground truth. It is offline research tooling only and
is not imported by the extension build.

## Run

```bash
python3 -m venv tools/causal-lab/.venv
tools/causal-lab/.venv/bin/pip install -r tools/causal-lab/requirements.txt
tools/causal-lab/.venv/bin/python -m unittest -v tools/causal-lab/test_benchmark.py
tools/causal-lab/.venv/bin/python tools/causal-lab/run_benchmark.py
```

Outputs are deterministic JSON and Markdown under `tools/causal-lab/results/`.
The runner uses separate development and held-out seeds and records both
skeleton recovery and definite orientation recovery. A production recommendation
is emitted only from held-out metrics. No result changes online safety gates.

## Decision rule

An algorithm is eligible only when held-out skeleton F1 is at least 0.80,
definite-orientation precision is at least 0.80, and it does not regress the
latent-confounded family below 0.70 skeleton F1. Even an eligible algorithm is
limited to offline hypothesis generation; online claims still require a bounded
intervention and rollback proof.
