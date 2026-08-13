#!/usr/bin/env python3
"""Compare headless agent groups with the released GRAIL human experiment."""

from __future__ import annotations

import argparse
import ast
import csv
import json
import math
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


TREATMENT_LABELS = {
    "noFacilitator_withCue_defaultHPT": "Message",
    "scoreboardFacilitation_noCue_defaultHPT": "LLM",
    "noFacilitator_noCue_defaultHPT": "None",
    "humanFacilitation_noCue_defaultHPT": "Human",
}
CITIES = ("Eldoron", "Myloria", "Cragnio")
ROLES = ("green", "pink", "blue", "orange", "red")
METRICS = (
    "n_messages_no_facilitator",
    "n_total_facts_mentioned",
    "fact_density",
    "options_gini_coef",
    "fact_sharing_min",
    "fact_sharing_max",
    "all_members_contributed_fact",
    "chose_eldoron",
    "unanimous",
)

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def as_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def gini(values: Iterable[float]) -> float:
    adjusted = sorted(float(value) + 1e-7 for value in values)
    count = len(adjusted)
    denominator = count * sum(adjusted)
    if denominator == 0:
        return 0.0
    numerator = sum(
        (2 * index - count - 1) * value
        for index, value in enumerate(adjusted, start=1)
    )
    return numerator / denominator


def majority(values: Iterable[str]) -> tuple[str | None, bool]:
    cleaned = [value for value in values if value in CITIES]
    if not cleaned:
        return None, False
    counts = Counter(cleaned)
    choice = max(CITIES, key=lambda city: counts[city])
    return choice, len(counts) == 1


def load_human_groups(data_dir: Path) -> list[dict[str, Any]]:
    games = read_csv(data_dir / "game.csv")
    players = read_csv(data_dir / "player.csv")
    with (data_dir / "dict_fact_detection.json").open(encoding="utf-8") as stream:
        fact_detection = json.load(stream)
    with (data_dir / "dict_approved_submissions.json").open(
        encoding="utf-8"
    ) as stream:
        approved_submissions = json.load(stream)

    terminated = {
        player["gameID"]
        for player in players
        if player.get("ended") == "game terminated"
    }
    selections: dict[str, list[str]] = defaultdict(list)
    for player in players:
        if player.get("name") != "Facilitator":
            selections[player.get("gameID", "")].append(
                player.get("selectedOption", "")
            )

    output: list[dict[str, Any]] = []
    for game in games:
        game_id = game["id"]
        treatment = TREATMENT_LABELS.get(game.get("treatmentName", ""))
        if (
            not game.get("chat")
            or not game.get("intro")
            or game_id in terminated
            or treatment is None
        ):
            continue

        messages = ast.literal_eval(game["chat"])
        speakers = {
            message.get("sender", {}).get("id")
            for message in messages
            if message.get("sender", {}).get("id") != "ai"
        }
        actual_players = as_int(game.get("actualPlayerCount"))
        approved = as_int(approved_submissions.get(game_id))
        if (
            len(speakers) != actual_players
            or len(messages) < 10
            or approved != actual_players
        ):
            continue

        detected = fact_detection.get(game_id, {})
        cumulative: set[str] = set()
        first_sender: dict[str, str] = {}
        no_facilitator_messages = 0
        for index, message in enumerate(messages):
            sender_name = (
                message.get("sender", {}).get("name", "").lower().strip()
            )
            if sender_name != "facilitator":
                no_facilitator_messages += 1
            for fact_id in detected.get(str(index), []) or []:
                cumulative.add(fact_id)
                first_sender.setdefault(fact_id, sender_name)

        role_contributions = Counter(first_sender.values())
        contribution_values = [role_contributions[role] for role in ROLES]
        city_coverage = [
            sum(fact_id.startswith(city[0]) for fact_id in cumulative)
            for city in CITIES
        ]
        group_choice, unanimous = majority(selections[game_id])
        total_facts = len(cumulative)
        output.append(
            {
                "group_id": game_id,
                "treatment": treatment,
                "n_messages_no_facilitator": no_facilitator_messages,
                "n_total_facts_mentioned": total_facts,
                "fact_density": (
                    total_facts / no_facilitator_messages
                    if no_facilitator_messages
                    else 0.0
                ),
                "options_gini_coef": gini(city_coverage),
                "fact_sharing_min": min(contribution_values),
                "fact_sharing_max": max(contribution_values),
                "all_members_contributed_fact": all(
                    value > 0 for value in contribution_values
                ),
                "chose_eldoron": group_choice == "Eldoron",
                "unanimous": unanimous,
                "group_selection": group_choice,
            }
        )
    return output


def load_agent_groups(run_dir: Path) -> list[dict[str, Any]]:
    groups = []
    for path in sorted(run_dir.rglob("*.json")):
        with path.open(encoding="utf-8") as stream:
            run = json.load(stream)
        if not {"run_id", "protocol", "metrics"}.issubset(run):
            continue
        reproducibility = run.get("reproducibility", {})
        persona_metadata = reproducibility.get("persona_metadata", {})
        metrics = dict(run["metrics"])
        metrics["group_id"] = run["run_id"]
        metrics["seed"] = run.get("seed")
        metrics["treatment"] = (
            "Message" if run["protocol"].get("hidden_info_cue") else "None"
        )
        metrics["provider"] = run["protocol"].get("provider")
        metrics["model"] = run["protocol"].get("model")
        metrics["fact_detector"] = run["protocol"].get(
            "fact_detector", "legacy-agent-declaration"
        )
        metrics["fact_detector_model"] = run["protocol"].get(
            "fact_detector_model"
        )
        metrics["fact_detector_paper_aligned"] = run["protocol"].get(
            "fact_detector_paper_aligned", False
        )
        metrics["team_id"] = persona_metadata.get("team_id")
        metrics["participant_ids"] = persona_metadata.get(
            "participant_ids", []
        )
        metrics["persona_variant"] = persona_metadata.get("persona_variant")
        metrics["dataset_revision"] = persona_metadata.get("dataset_revision")
        groups.append(metrics)
    if not groups:
        raise ValueError(f"No agent run JSON files found in {run_dir}.")
    return groups


def mean_sd(values: Iterable[Any]) -> dict[str, float | int]:
    numeric = [float(value) for value in values]
    return {
        "n": len(numeric),
        "mean": statistics.fmean(numeric) if numeric else math.nan,
        "sd": statistics.stdev(numeric) if len(numeric) > 1 else 0.0,
    }


def summarize(
    groups: list[dict[str, Any]], treatment_key: str = "treatment"
) -> dict[str, dict[str, dict[str, float | int]]]:
    by_treatment: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for group in groups:
        by_treatment[group[treatment_key]].append(group)
    return {
        treatment: {
            metric: mean_sd(group[metric] for group in treatment_groups)
            for metric in METRICS
        }
        for treatment, treatment_groups in sorted(by_treatment.items())
    }


def compare(
    human_summary: dict[str, Any],
    agent_summary: dict[str, Any],
    treatment: str,
) -> dict[str, dict[str, float | int | None]]:
    human = human_summary[treatment]
    agent = agent_summary[treatment]
    comparison = {}
    for metric in METRICS:
        difference = agent[metric]["mean"] - human[metric]["mean"]
        human_sd = human[metric]["sd"]
        comparison[metric] = {
            "human_n": human[metric]["n"],
            "human_mean": human[metric]["mean"],
            "human_sd": human_sd,
            "agent_n": agent[metric]["n"],
            "agent_mean": agent[metric]["mean"],
            "agent_sd": agent[metric]["sd"],
            "difference_agent_minus_human": difference,
            "difference_in_human_sd": (
                difference / human_sd if human_sd > 0 else None
            ),
        }
    return comparison


def write_comparison_csv(path: Path, comparison: dict[str, dict[str, Any]]) -> None:
    rows = [{"metric": metric, **values} for metric, values in comparison.items()]
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(
            stream,
            fieldnames=rows[0].keys(),
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--osf-data", type=Path, required=True)
    parser.add_argument("--agent-runs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    human_groups = load_human_groups(args.osf_data)
    agent_groups = load_agent_groups(args.agent_runs)
    agent_treatments = {group["treatment"] for group in agent_groups}
    if len(agent_treatments) != 1:
        raise ValueError(
            "Agent run directory mixes cue and no-cue treatments; "
            "compare one treatment at a time."
        )
    human_summary = summarize(human_groups)
    agent_summary = summarize(agent_groups)
    target_treatment = agent_treatments.pop()
    comparison = compare(human_summary, agent_summary, target_treatment)
    detector_methods = sorted(
        {
            (
                group["fact_detector"],
                group["fact_detector_model"],
                group["fact_detector_paper_aligned"],
            )
            for group in agent_groups
        },
        key=str,
    )

    payload = {
        "reference_dataset": "GRAIL publicly released experiment",
        "target_treatment": target_treatment,
        "human_summary": human_summary,
        "agent_summary": agent_summary,
        "comparison": comparison,
        "agent_fact_detector_methods": [
            {
                "detector": detector,
                "model": model,
                "paper_aligned": paper_aligned,
            }
            for detector, model, paper_aligned in detector_methods
        ],
        "notes": [
            "Human exclusions reproduce the released notebook: all assigned participants spoke, at least 10 messages were sent, and all submissions were approved.",
            "Human transcript facts are the released GRAIL post-hoc GPT-4o annotations.",
            "Agent fact coverage uses each run's recorded post-hoc detector; agent declarations are not used as measurements.",
            "Detector-method differences must be considered unless agent_fact_detector_methods reports OpenAI gpt-4o with paper_aligned=true.",
            "This is a descriptive research extension, not a model evaluation or benchmark. The OSF release explicitly states that the dataset was not intended for evaluating model quality.",
            "The comparison does not show that unpersonalized or survey-personalized agents predict matched human groups.",
        ],
    }
    json_path = args.output / "grail_comparison.json"
    csv_path = args.output / "grail_comparison.csv"
    with json_path.open("w", encoding="utf-8") as stream:
        json.dump(payload, stream, indent=2)
        stream.write("\n")
    write_comparison_csv(csv_path, comparison)

    print(
        f"Compared {len(agent_groups)} agent group(s) with "
        f"{human_summary[target_treatment][METRICS[0]]['n']} human "
        f"{target_treatment} groups."
    )
    print(f"Wrote {json_path} and {csv_path}.")


if __name__ == "__main__":
    main()
