#!/usr/bin/env python3
"""M7: deterministic PC/GES/FCI comparison on browser-mechanism SCM fixtures."""

from __future__ import annotations

import json
import contextlib
import io
import importlib.metadata
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
from causallearn.search.ConstraintBased.FCI import fci
from causallearn.search.ConstraintBased.PC import pc
from causallearn.search.ScoreBased.GES import ges

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
NAMES = ["blocked", "bait", "script", "overlay", "scroll", "content", "privacy"]
INDEX = {name: index for index, name in enumerate(NAMES)}
TAIL, ARROW, CIRCLE = -1, 1, 2


@dataclass(frozen=True)
class Family:
    name: str
    edges: tuple[tuple[str, str, float], ...]
    latent: tuple[tuple[str, str, float], ...] = ()


FAMILIES = (
    Family("blocked_overlay", (("blocked", "overlay", 1.0), ("overlay", "content", -0.9))),
    Family("bait_overlay", (("bait", "overlay", 1.1), ("overlay", "scroll", 0.8), ("scroll", "content", -0.7))),
    Family("script_scroll", (("script", "scroll", 1.0), ("scroll", "content", -0.9))),
    Family("overlay_reinsertion", (("script", "overlay", 0.8), ("bait", "overlay", 0.7), ("overlay", "content", -1.0))),
    Family("privacy_tradeoff", (("blocked", "privacy", 0.9), ("privacy", "content", -0.6))),
    Family("collider_gate", (("blocked", "overlay", 0.9), ("bait", "overlay", 0.9), ("overlay", "content", -0.8))),
    Family("fork_script", (("script", "overlay", 0.8), ("script", "scroll", 0.9), ("overlay", "content", -0.7))),
    Family("long_chain", (("blocked", "script", 0.8), ("script", "overlay", 0.8), ("overlay", "scroll", 0.8), ("scroll", "content", -0.8))),
    Family("benign_independent", ()),
    Family("weak_delayed_proxy", (("blocked", "overlay", 0.35), ("overlay", "content", -0.4))),
    Family("latent_server_bucket", (("overlay", "content", -0.8),), (("blocked", "overlay", 0.9), ("blocked", "privacy", 0.8))),
    Family("latent_account_state", (("scroll", "content", -0.7),), (("bait", "overlay", 0.9), ("bait", "scroll", 0.8))),
)


def simulate(family: Family, seed: int, samples: int = 1200) -> np.ndarray:
    rng = np.random.default_rng(seed)
    data = rng.normal(0, 1, size=(samples, len(NAMES)))
    hidden = rng.normal(0, 1, size=samples)
    for source, target, weight in family.latent:
        data[:, INDEX[target]] += weight * hidden
    # All declared observed edges are topologically ordered by NAMES.
    for source, target, weight in family.edges:
        data[:, INDEX[target]] += weight * data[:, INDEX[source]]
    data += rng.normal(0, 0.15, size=data.shape)
    return (data - data.mean(axis=0)) / data.std(axis=0)


def true_edges(family: Family) -> set[tuple[int, int]]:
    return {(INDEX[source], INDEX[target]) for source, target, _ in family.edges}


def true_skeleton(family: Family) -> set[frozenset[int]]:
    skeleton = {frozenset(edge) for edge in true_edges(family)}
    # Every pair of observed targets sharing the synthetic hidden cause belongs
    # in the observed MAG/PAG skeleton, though it has no observed DAG direction.
    latent_targets = [INDEX[target] for _, target, _ in family.latent]
    for pos, left in enumerate(latent_targets):
        for right in latent_targets[pos + 1:]:
            skeleton.add(frozenset((left, right)))
    return skeleton


def learned_edges(graph: np.ndarray) -> tuple[set[frozenset[int]], set[tuple[int, int]]]:
    skeleton: set[frozenset[int]] = set()
    directed: set[tuple[int, int]] = set()
    for i in range(graph.shape[0]):
        for j in range(i + 1, graph.shape[1]):
            a, b = int(graph[i, j]), int(graph[j, i])
            if a == 0 and b == 0:
                continue
            skeleton.add(frozenset((i, j)))
            if a == TAIL and b == ARROW:
                directed.add((i, j))
            elif a == ARROW and b == TAIL:
                directed.add((j, i))
    return skeleton, directed


def ratio(num: int, den: int, empty: float) -> float:
    return empty if den == 0 else num / den


def metrics(family: Family, graph: np.ndarray) -> dict[str, float | int]:
    truth = true_edges(family)
    expected_skeleton = true_skeleton(family)
    learned_skeleton, learned_directed = learned_edges(graph)
    sk_tp = len(expected_skeleton & learned_skeleton)
    dir_tp = len(truth & learned_directed)
    sk_precision = ratio(sk_tp, len(learned_skeleton), 1.0 if not expected_skeleton else 0.0)
    sk_recall = ratio(sk_tp, len(expected_skeleton), 1.0)
    dir_precision = ratio(dir_tp, len(learned_directed), 1.0 if not truth else 0.0)
    dir_recall = ratio(dir_tp, len(truth), 1.0)
    return {
        "skeleton_precision": sk_precision,
        "skeleton_recall": sk_recall,
        "skeleton_f1": ratio(2 * sk_precision * sk_recall, sk_precision + sk_recall, 0.0),
        "orientation_precision": dir_precision,
        "orientation_recall": dir_recall,
        "orientation_f1": ratio(2 * dir_precision * dir_recall, dir_precision + dir_recall, 0.0),
        "skeleton_shd": len(expected_skeleton ^ learned_skeleton),
        "learned_adjacencies": len(learned_skeleton),
        "learned_directions": len(learned_directed),
    }


def discover(algorithm: str, data: np.ndarray) -> np.ndarray:
    if algorithm == "PC":
        return pc(data, alpha=0.01, stable=True, show_progress=False, verbose=False).G.graph
    if algorithm == "GES":
        return ges(data, score_func="local_score_BIC", maxP=4)["G"].graph
    if algorithm == "FCI":
        # causal-learn 0.1.4.4 prints some oriented edges even with verbose=False.
        with contextlib.redirect_stdout(io.StringIO()):
            graph, _ = fci(data, independence_test_method="fisherz", alpha=0.01, depth=3, max_path_length=5, verbose=False, show_progress=False)
        return graph.graph
    raise ValueError(algorithm)


def aggregate(rows: Iterable[dict[str, object]]) -> dict[str, float]:
    rows = list(rows)
    metric_names = ("skeleton_precision", "skeleton_recall", "skeleton_f1", "orientation_precision", "orientation_recall", "orientation_f1", "skeleton_shd")
    return {name: float(np.mean([float(row[name]) for row in rows])) for name in metric_names}


def main() -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    splits = {"development": (101, 102, 103), "holdout": (901, 902, 903)}
    algorithms = ("PC", "GES", "FCI")
    rows: list[dict[str, object]] = []
    for split, seeds in splits.items():
        for family in FAMILIES:
            for seed in seeds:
                data = simulate(family, seed)
                for algorithm in algorithms:
                    result = metrics(family, discover(algorithm, data))
                    rows.append({"split": split, "family": family.name, "seed": seed, "algorithm": algorithm, **result})

    summary: dict[str, dict[str, dict[str, float]]] = {}
    for split in splits:
        summary[split] = {}
        for algorithm in algorithms:
            summary[split][algorithm] = aggregate(row for row in rows if row["split"] == split and row["algorithm"] == algorithm)

    latent_names = {family.name for family in FAMILIES if family.latent}
    decision: dict[str, object] = {}
    eligible: list[str] = []
    for algorithm in algorithms:
        held = summary["holdout"][algorithm]
        latent = aggregate(row for row in rows if row["split"] == "holdout" and row["algorithm"] == algorithm and row["family"] in latent_names)
        passes = held["skeleton_f1"] >= 0.80 and held["orientation_precision"] >= 0.80 and latent["skeleton_f1"] >= 0.70
        decision[algorithm] = {"eligible": passes, "holdout": held, "latent_holdout": latent}
        if passes:
            eligible.append(algorithm)
    recommendation = (
        f"{max(eligible, key=lambda name: summary['holdout'][name]['skeleton_f1'])} is eligible only as an offline hypothesis generator."
        if eligible else
        "No algorithm clears the held-out gate; keep PC, GES, and FCI research-only and retain intervention-first online reasoning."
    )
    output = {
        "schema": "adapt-causal-lab-v1",
        "dependencies": {
            "causal-learn": importlib.metadata.version("causal-learn"),
            "numpy": np.__version__,
            "scipy": importlib.metadata.version("scipy"),
            "scikit-learn": importlib.metadata.version("scikit-learn"),
            "pandas": importlib.metadata.version("pandas"),
            "networkx": importlib.metadata.version("networkx"),
            "matplotlib": importlib.metadata.version("matplotlib"),
        },
        "samples_per_run": 1200,
        "variables": NAMES,
        "families": [asdict(family) for family in FAMILIES],
        "rows": rows,
        "summary": summary,
        "decision": decision,
        "recommendation": recommendation,
    }
    (RESULTS / "benchmark.json").write_text(json.dumps(output, indent=2) + "\n")

    lines = [
        "# ADAPT M7 causal discovery benchmark", "",
        "Held-out results decide eligibility; development results are diagnostic only.", "",
        "Implementation: fully pinned Python dependency set (see benchmark.json), 12 SCM families, three development seeds, three held-out seeds, 1,200 samples per family/seed, and 216 total runs.", "",
        "| Algorithm | Skeleton F1 | Orientation precision | Orientation recall | Latent skeleton F1 | Eligible |",
        "|---|---:|---:|---:|---:|---|",
    ]
    for algorithm in algorithms:
        held = decision[algorithm]["holdout"]
        latent = decision[algorithm]["latent_holdout"]
        lines.append(f"| {algorithm} | {held['skeleton_f1']:.3f} | {held['orientation_precision']:.3f} | {held['orientation_recall']:.3f} | {latent['skeleton_f1']:.3f} | {'yes' if decision[algorithm]['eligible'] else 'no'} |")
    lines += [
        "", "## Decision", "", recommendation, "",
        "The benchmark does not identify causal effects for production. Online support still requires a document-scoped, reversible intervention, measured health improvement, privacy preservation, and verified rollback.",
        "", "## Method references", "",
        "- [causal-learn package paper](https://arxiv.org/abs/2307.16405)",
        "- [PC API](https://causal-learn.readthedocs.io/en/latest/search_methods_index/Constraint-based%20causal%20discovery%20methods/PC.html)",
        "- [GES API and endpoint encoding](https://causal-learn.readthedocs.io/en/latest/search_methods_index/Score-based%20causal%20discovery%20methods/GES.html)",
        "- [FCI API and PAG semantics](https://causal-learn.readthedocs.io/en/latest/search_methods_index/Constraint-based%20causal%20discovery%20methods/FCI.html)",
        "",
    ]
    (RESULTS / "REPORT.md").write_text("\n".join(lines))
    print(json.dumps({"summary": summary["holdout"], "recommendation": recommendation}, indent=2))


if __name__ == "__main__":
    main()
