# ADAPT M7 causal discovery benchmark

Held-out results decide eligibility; development results are diagnostic only.

Implementation: fully pinned Python dependency set (see benchmark.json), 12 SCM families, three development seeds, three held-out seeds, 1,200 samples per family/seed, and 216 total runs.

| Algorithm | Skeleton F1 | Orientation precision | Orientation recall | Latent skeleton F1 | Eligible |
|---|---:|---:|---:|---:|---|
| PC | 1.000 | 0.250 | 0.250 | 1.000 | no |
| GES | 1.000 | 0.250 | 0.250 | 1.000 | no |
| FCI | 1.000 | 0.250 | 0.139 | 1.000 | no |

## Decision

No algorithm clears the held-out gate; keep PC, GES, and FCI research-only and retain intervention-first online reasoning.

The benchmark does not identify causal effects for production. Online support still requires a document-scoped, reversible intervention, measured health improvement, privacy preservation, and verified rollback.

## Method references

- [causal-learn package paper](https://arxiv.org/abs/2307.16405)
- [PC API](https://causal-learn.readthedocs.io/en/latest/search_methods_index/Constraint-based%20causal%20discovery%20methods/PC.html)
- [GES API and endpoint encoding](https://causal-learn.readthedocs.io/en/latest/search_methods_index/Score-based%20causal%20discovery%20methods/GES.html)
- [FCI API and PAG semantics](https://causal-learn.readthedocs.io/en/latest/search_methods_index/Constraint-based%20causal%20discovery%20methods/FCI.html)
