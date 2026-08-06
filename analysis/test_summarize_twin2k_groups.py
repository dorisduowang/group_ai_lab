import unittest

from compare_to_grail import METRICS
from summarize_twin2k_groups import summarize_teams


def group(team_id, participant_ids, seed, facts):
    return {
        "group_id": f"{team_id}-{seed}",
        "team_id": team_id,
        "participant_ids": participant_ids,
        "persona_variant": "persona_text",
        "dataset_revision": "revision-1",
        "provider": "fixture",
        "model": "fixture",
        "fact_detector": "fixture-detector",
        "fact_detector_model": "fixture-detector-model",
        "treatment": "None",
        "seed": seed,
        **{
            metric: facts if metric == "n_total_facts_mentioned" else 0
            for metric in METRICS
        },
    }


class Twin2KSummaryTests(unittest.TestCase):
    def test_summarizes_matched_teams(self):
        groups = [
            group("team-001", ["1", "2", "3", "4", "5"], 100, 4),
            group("team-001", ["1", "2", "3", "4", "5"], 101, 6),
            group("team-002", ["6", "7", "8", "9", "10"], 100, 8),
            group("team-002", ["6", "7", "8", "9", "10"], 101, 10),
        ]
        summary = summarize_teams(groups)
        self.assertEqual(summary["team_count"], 2)
        self.assertEqual(summary["seeds"], [100, 101])
        self.assertEqual(
            summary["teams"]["team-001"]["metrics"][
                "n_total_facts_mentioned"
            ]["mean"],
            5,
        )

    def test_rejects_unmatched_seeds(self):
        groups = [
            group("team-001", ["1", "2", "3", "4", "5"], 100, 4),
            group("team-002", ["6", "7", "8", "9", "10"], 101, 8),
        ]
        with self.assertRaisesRegex(ValueError, "matched seed sets"):
            summarize_teams(groups)

    def test_rejects_inconsistent_membership(self):
        groups = [
            group("team-001", ["1", "2", "3", "4", "5"], 100, 4),
            group("team-001", ["1", "2", "3", "4", "6"], 101, 6),
        ]
        with self.assertRaisesRegex(ValueError, "inconsistent participant"):
            summarize_teams(groups)


if __name__ == "__main__":
    unittest.main()
