#!/usr/bin/env python3
"""Summarize matched GRAIL runs across Twin-2K team compositions."""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from compare_to_grail import METRICS, load_agent_groups, mean_sd


MATCHED_FIELDS = (
    "persona_variant",
    "dataset_revision",
    "provider",
    "model",
    "fact_detector",
    "fact_detector_model",
    "treatment",
)


def summarize_teams(groups: list[dict[str, Any]]) -> dict[str, Any]:
    by_team: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for group in groups:
        team_id = group.get("team_id")
        if not team_id:
            raise ValueError(
                f"Run {group['group_id']} has no Twin-2K team metadata."
            )
        by_team[team_id].append(group)

    teams = {}
    seed_sets = set()
    settings = {}
    for field in MATCHED_FIELDS:
        values = {group.get(field) for group in groups}
        if len(values) != 1:
            raise ValueError(
                f"Twin runs use different {field} values. Keep every setting "
                "except team composition fixed."
            )
        settings[field] = next(iter(values))

    for team_id, team_groups in sorted(by_team.items()):
        memberships = {
            tuple(group.get("participant_ids", [])) for group in team_groups
        }
        if len(memberships) != 1:
            raise ValueError(f"Team {team_id} has inconsistent participant IDs.")
        membership = next(iter(memberships))
        if len(membership) != 5 or len(set(membership)) != 5:
            raise ValueError(
                f"Team {team_id} must contain five distinct participant IDs."
            )
        if any(group.get("seed") is None for group in team_groups):
            raise ValueError(f"Team {team_id} has a run without a recorded seed.")
        seeds = tuple(sorted(group["seed"] for group in team_groups))
        seed_sets.add(seeds)
        first = team_groups[0]
        teams[team_id] = {
            "participant_ids": list(membership),
            "persona_variant": first.get("persona_variant"),
            "dataset_revision": first.get("dataset_revision"),
            "provider": first.get("provider"),
            "model": first.get("model"),
            "seeds": list(seeds),
            "metrics": {
                metric: mean_sd(group[metric] for group in team_groups)
                for metric in METRICS
            },
        }

    if len(seed_sets) != 1:
        raise ValueError(
            "Twin teams do not have matched seed sets. Run the same seeds for "
            "every composition before comparing them."
        )
    return {
        "schema_version": "1.0",
        "design": "matched GRAIL seeds across Twin-2K team compositions",
        "team_count": len(teams),
        "seeds": list(next(iter(seed_sets))),
        "matched_settings": settings,
        "teams": teams,
    }


def write_metric_csv(path: Path, summary: dict[str, Any]) -> None:
    rows = []
    for team_id, team in summary["teams"].items():
        for metric, values in team["metrics"].items():
            rows.append(
                {
                    "team_id": team_id,
                    "participant_ids": ";".join(team["participant_ids"]),
                    "persona_variant": team["persona_variant"],
                    "metric": metric,
                    **values,
                }
            )
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-runs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    summary = summarize_teams(load_agent_groups(args.agent_runs))
    args.output.mkdir(parents=True, exist_ok=True)
    json_path = args.output / "twin2k_team_summary.json"
    csv_path = args.output / "twin2k_team_metrics.csv"
    json_path.write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf-8",
    )
    write_metric_csv(csv_path, summary)
    print(f"Summarized {summary['team_count']} matched Twin-2K teams.")
    print(f"Wrote {json_path} and {csv_path}.")


if __name__ == "__main__":
    main()
