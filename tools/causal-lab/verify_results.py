#!/usr/bin/env python3
"""Independently recompute the M7 summary and release decision from raw rows."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from statistics import fmean

ROOT = Path(__file__).resolve().parent
RESULT = ROOT / "results" / "benchmark.json"
METRICS = (
    "skeleton_precision",
    "skeleton_recall",
    "skeleton_f1",
    "orientation_precision",
    "orientation_recall",
    "orientation_f1",
    "skeleton_shd",
)
ALGORITHMS = {"PC", "GES", "FCI"}
SPLIT_SEEDS = {"development": {101, 102, 103}, "holdout": {901, 902, 903}}


def close(left: float, right: float, tolerance: float = 1e-12) -> bool:
    return abs(left - right) <= tolerance


def main() -> None:
    payload = json.loads(RESULT.read_text())
    rows = payload["rows"]
    families = {family["name"] for family in payload["families"]}
    latent = {family["name"] for family in payload["families"] if family["latent"]}

    expected_runs = len(families) * len(ALGORITHMS) * sum(len(seeds) for seeds in SPLIT_SEEDS.values())
    assert len(rows) == expected_runs == 216, (len(rows), expected_runs)
    assert {row["family"] for row in rows} == families
    assert {row["algorithm"] for row in rows} == ALGORITHMS
    for split, seeds in SPLIT_SEEDS.items():
        assert {row["seed"] for row in rows if row["split"] == split} == seeds

    grouped: dict[tuple[str, str], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        grouped[(str(row["split"]), str(row["algorithm"]))].append(row)

    recomputed: dict[str, dict[str, dict[str, float]]] = defaultdict(dict)
    for (split, algorithm), group in grouped.items():
        recomputed[split][algorithm] = {
            metric: fmean(float(row[metric]) for row in group) for metric in METRICS
        }
        recorded = payload["summary"][split][algorithm]
        assert all(close(value, float(recorded[metric])) for metric, value in recomputed[split][algorithm].items())

    for algorithm in ALGORITHMS:
        held = recomputed["holdout"][algorithm]
        latent_rows = [
            row for row in rows
            if row["split"] == "holdout" and row["algorithm"] == algorithm and row["family"] in latent
        ]
        latent_skeleton_f1 = fmean(float(row["skeleton_f1"]) for row in latent_rows)
        eligible = (
            held["skeleton_f1"] >= 0.80
            and held["orientation_precision"] >= 0.80
            and latent_skeleton_f1 >= 0.70
        )
        assert eligible is bool(payload["decision"][algorithm]["eligible"])

    print(json.dumps({
        "verified": True,
        "run_count": len(rows),
        "families": len(families),
        "algorithms": sorted(ALGORITHMS),
        "seeds": {key: sorted(value) for key, value in SPLIT_SEEDS.items()},
        "decision": {name: payload["decision"][name]["eligible"] for name in sorted(ALGORITHMS)},
    }, indent=2))


if __name__ == "__main__":
    main()
