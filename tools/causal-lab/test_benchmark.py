import unittest
from pathlib import Path
import sys

import numpy as np

# Support both direct execution and repository-root unittest discovery.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_benchmark as lab


class CausalLabTests(unittest.TestCase):
    def test_latent_common_cause_is_in_observed_skeleton_only(self):
        family = next(item for item in lab.FAMILIES if item.name == "latent_server_bucket")
        skeleton = lab.true_skeleton(family)
        self.assertIn(frozenset((lab.INDEX["overlay"], lab.INDEX["privacy"])), skeleton)
        self.assertNotIn((lab.INDEX["overlay"], lab.INDEX["privacy"]), lab.true_edges(family))

    def test_pc_recovers_collider_directions(self):
        family = next(item for item in lab.FAMILIES if item.name == "collider_gate")
        result = lab.metrics(family, lab.discover("PC", lab.simulate(family, 901)))
        self.assertGreaterEqual(result["skeleton_f1"], 0.99)
        self.assertGreaterEqual(result["orientation_precision"], 0.99)

    def test_chain_is_not_falsely_counted_as_definitely_oriented(self):
        family = next(item for item in lab.FAMILIES if item.name == "blocked_overlay")
        result = lab.metrics(family, lab.discover("PC", lab.simulate(family, 901)))
        self.assertEqual(result["orientation_recall"], 0.0)

    def test_all_algorithms_return_square_endpoint_matrices(self):
        family = lab.FAMILIES[0]
        data = lab.simulate(family, 101, samples=500)
        for algorithm in ("PC", "GES", "FCI"):
            with self.subTest(algorithm=algorithm):
                graph = lab.discover(algorithm, data)
                self.assertEqual(graph.shape, (len(lab.NAMES), len(lab.NAMES)))
                self.assertTrue(np.isin(graph, [-1, 0, 1, 2]).all())


if __name__ == "__main__":
    unittest.main()
