import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import build_twin2k_teams


class Twin2KTeamTests(unittest.TestCase):
    def test_row_url_can_pin_the_dataset_revision(self) -> None:
        query = parse_qs(
            urlparse(
                build_twin2k_teams.row_url(7, revision="revision-123")
            ).query
        )
        self.assertEqual(query["offset"], ["7"])
        self.assertEqual(query["revision"], ["revision-123"])

    def test_seeded_selection_is_distinct_and_repeatable(self) -> None:
        first = build_twin2k_teams.choose_indices(100, 3, 5, 718)
        second = build_twin2k_teams.choose_indices(100, 3, 5, 718)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 15)
        self.assertEqual(len(set(first)), 15)

    def test_supplied_indices_must_cover_every_team(self) -> None:
        with self.assertRaisesRegex(ValueError, "Expected 10 row indices"):
            build_twin2k_teams.choose_indices(100, 2, 5, 1, [1, 2, 3])

    def test_team_preserves_dataset_provenance(self) -> None:
        rows = [
            {
                "pid": str(100 + index),
                "persona_summary": f"Profile {index}",
                "_row_index": index,
            }
            for index in range(5)
        ]
        team = build_twin2k_teams.make_team(
            rows,
            "team-001",
            "persona_summary",
            "revision-123",
            100,
        )

        self.assertEqual(len(team["agents"]), 5)
        self.assertEqual(team["metadata"]["source"], "twin2k-500")
        self.assertEqual(team["metadata"]["participant_ids"][0], "100")
        self.assertEqual(team["agents"][0]["base_prompt"], "Profile 0")
        self.assertEqual(len(team["agents"][0]["persona_sha256"]), 64)

    def test_json_writer_is_stable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "team.json"
            build_twin2k_teams.write_json(path, {"b": 2, "a": 1})
            first = path.read_bytes()
            build_twin2k_teams.write_json(path, {"b": 2, "a": 1})
            self.assertEqual(first, path.read_bytes())

    def test_builder_rejects_stale_team_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "team-002.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "team-002.json"):
                build_twin2k_teams.check_output_directory(root, 1)

    def test_selected_participants_must_be_distinct(self) -> None:
        rows = [{"pid": "12"}, {"pid": "12"}]
        with self.assertRaisesRegex(ValueError, "distinct participant"):
            build_twin2k_teams.check_participants(rows)


if __name__ == "__main__":
    unittest.main()
