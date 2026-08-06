import unittest
import json
import tempfile
from pathlib import Path

import compare_to_grail
from compare_to_grail import compare, gini, load_agent_groups, majority, mean_sd


class CompareToGrailTests(unittest.TestCase):
    def test_majority_and_unanimity(self):
        self.assertEqual(
            majority(["Eldoron", "Eldoron", "Myloria"]),
            ("Eldoron", False),
        )
        self.assertEqual(
            majority(["Cragnio", "Cragnio"]),
            ("Cragnio", True),
        )

    def test_gini_is_zero_for_equal_coverage(self):
        self.assertAlmostEqual(gini([4, 4, 4]), 0.0)
        self.assertGreater(gini([0, 0, 12]), 0.6)

    def test_descriptive_comparison_uses_human_sd(self):
        human = {"None": {"metric": {"n": 3, "mean": 10.0, "sd": 2.0}}}
        agent = {"None": {"metric": {"n": 2, "mean": 12.0, "sd": 1.0}}}
        old_metrics = compare_to_grail.METRICS
        compare_to_grail.METRICS = ("metric",)
        try:
            result = compare(human, agent, "None")["metric"]
        finally:
            compare_to_grail.METRICS = old_metrics
        self.assertEqual(result["difference_agent_minus_human"], 2.0)
        self.assertEqual(result["difference_in_human_sd"], 1.0)

    def test_mean_sd_handles_booleans(self):
        result = mean_sd([True, False, True])
        self.assertAlmostEqual(result["mean"], 2 / 3)

    def test_agent_loader_ignores_manifest_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "experiment-manifest.json").write_text(
                json.dumps({"schema_version": "1.0", "run_ids": ["run-1"]}),
                encoding="utf-8",
            )
            (root / "run-1.json").write_text(
                json.dumps(
                    {
                        "run_id": "run-1",
                        "protocol": {
                            "hidden_info_cue": False,
                            "fact_detector": "fixture",
                            "fact_detector_model": "fixture-model",
                        },
                        "metrics": {"n_total_facts_mentioned": 3},
                    }
                ),
                encoding="utf-8",
            )
            groups = load_agent_groups(root)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["group_id"], "run-1")
        self.assertEqual(groups[0]["fact_detector"], "fixture")

    def test_agent_loader_finds_nested_twin_team_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            team_dir = root / "team-001"
            team_dir.mkdir()
            (team_dir / "run-1.json").write_text(
                json.dumps(
                    {
                        "run_id": "run-1",
                        "seed": 100,
                        "protocol": {"hidden_info_cue": False},
                        "reproducibility": {
                            "persona_metadata": {
                                "team_id": "team-001",
                                "participant_ids": ["12", "34"],
                                "persona_variant": "persona_summary",
                            }
                        },
                        "metrics": {"n_total_facts_mentioned": 3},
                    }
                ),
                encoding="utf-8",
            )
            groups = load_agent_groups(root)
        self.assertEqual(groups[0]["team_id"], "team-001")
        self.assertEqual(groups[0]["participant_ids"], ["12", "34"])
        self.assertEqual(groups[0]["seed"], 100)


if __name__ == "__main__":
    unittest.main()
