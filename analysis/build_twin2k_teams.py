#!/usr/bin/env python3
"""Build five-person GRAIL teams from the public Twin-2K-500 personas."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import random
import subprocess
import urllib.parse
from pathlib import Path
from typing import Any


DATASET = "LLM-Digital-Twin/Twin-2K-500"
CONFIG = "full_persona"
SPLIT = "data"
DATASET_API = f"https://huggingface.co/api/datasets/{DATASET}"
ROWS_API = "https://datasets-server.huggingface.co/rows"
VARIANTS = ("persona_text", "persona_summary", "persona_json")


def fetch_json(url: str) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            [
                "curl",
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--connect-timeout",
                "10",
                "--max-time",
                "60",
                "--retry",
                "2",
                "--user-agent",
                "group-ai-lab-twin2k-adapter/1.0",
                url,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)
    except (FileNotFoundError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not retrieve {url}: {error}") from error


def row_url(offset: int, length: int = 1, revision: str | None = None) -> str:
    parameters = {
        "dataset": DATASET,
        "config": CONFIG,
        "split": SPLIT,
        "offset": offset,
        "length": length,
    }
    if revision:
        parameters["revision"] = revision
    query = urllib.parse.urlencode(parameters)
    return f"{ROWS_API}?{query}"


def choose_indices(
    total_rows: int,
    team_count: int,
    team_size: int,
    seed: int,
    supplied: list[int] | None = None,
) -> list[int]:
    required = team_count * team_size
    if supplied is not None:
        if len(supplied) != required:
            raise ValueError(
                f"Expected {required} row indices for {team_count} teams; "
                f"received {len(supplied)}."
            )
        if len(set(supplied)) != len(supplied):
            raise ValueError("Row indices must be distinct.")
        if any(index < 0 or index >= total_rows for index in supplied):
            raise ValueError(f"Row indices must be between 0 and {total_rows - 1}.")
        return supplied
    if required > total_rows:
        raise ValueError(f"Cannot draw {required} distinct people from {total_rows} rows.")
    return random.Random(seed).sample(range(total_rows), required)


def retrieve_rows(
    indices: list[int],
    revision: str,
    fetch=fetch_json,
) -> list[dict[str, Any]]:
    def retrieve(index: int) -> dict[str, Any]:
        payload = fetch(row_url(index, revision=revision))
        returned = payload.get("rows", [])
        if len(returned) != 1:
            raise RuntimeError(f"Expected one dataset row at offset {index}.")
        row = dict(returned[0].get("row", {}))
        row["_row_index"] = index
        return row

    with ThreadPoolExecutor(max_workers=min(5, len(indices))) as executor:
        return list(executor.map(retrieve, indices))


def check_participants(rows: list[dict[str, Any]]) -> None:
    participant_ids = [str(row.get("pid", "")).strip() for row in rows]
    if any(not participant_id for participant_id in participant_ids):
        raise ValueError("Every selected row must contain a participant ID.")
    if len(set(participant_ids)) != len(participant_ids):
        raise ValueError("Selected rows must contain distinct participant IDs.")


def persona_value(row: dict[str, Any], variant: str) -> str:
    value = row.get(variant)
    if variant == "persona_json" and not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"Participant {row.get('pid')} has no usable {variant} value."
        )
    return value.strip()


def make_team(
    rows: list[dict[str, Any]],
    team_id: str,
    variant: str,
    revision: str,
    selection_seed: int,
) -> dict[str, Any]:
    agents = []
    participant_ids = []
    row_indices = []
    for position, row in enumerate(rows, start=1):
        participant_id = str(row["pid"])
        profile = persona_value(row, variant)
        participant_ids.append(participant_id)
        row_indices.append(row["_row_index"])
        agents.append(
            {
                "id": f"{team_id}-member-{position:02d}",
                "name": f"Twin {position}",
                "base_prompt": profile,
                "participant_id": participant_id,
                "persona_sha256": hashlib.sha256(profile.encode()).hexdigest(),
            }
        )

    return {
        "metadata": {
            "source": "twin2k-500",
            "dataset": DATASET,
            "dataset_revision": revision,
            "dataset_config": CONFIG,
            "dataset_split": SPLIT,
            "persona_variant": variant,
            "selection_seed": selection_seed,
            "team_id": team_id,
            "row_indices": row_indices,
            "participant_ids": participant_ids,
        },
        "agents": agents,
    }


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def check_output_directory(output_dir: Path, team_count: int) -> None:
    expected = {f"team-{index + 1:03d}.json" for index in range(team_count)}
    stale = sorted(
        path.name
        for path in output_dir.glob("team-*.json")
        if path.name not in expected
    )
    if stale:
        raise RuntimeError(
            "Output directory contains team files outside this build: "
            + ", ".join(stale)
            + ". Use a new directory or move those files first."
        )


def parse_indices(value: str | None) -> list[int] | None:
    if value is None:
        return None
    try:
        return [int(item.strip()) for item in value.split(",") if item.strip()]
    except ValueError as error:
        raise argparse.ArgumentTypeError("Row indices must be integers.") from error


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--teams", type=int, default=1)
    parser.add_argument("--team-size", type=int, default=5)
    parser.add_argument("--seed", type=int, default=100)
    parser.add_argument("--variant", choices=VARIANTS, default="persona_text")
    parser.add_argument(
        "--row-indices",
        help="Comma-separated dataset row offsets for an exact rebuild.",
    )
    args = parser.parse_args()
    if args.teams < 1:
        parser.error("--teams must be positive")
    if args.team_size != 5:
        parser.error("GRAIL teams must contain exactly five participants")
    return args


def main() -> None:
    args = parse_args()
    dataset = fetch_json(DATASET_API)
    revision = dataset.get("sha")
    if not revision:
        raise RuntimeError("Hugging Face did not return a dataset revision.")

    first_page = fetch_json(row_url(0, revision=revision))
    total_rows = int(first_page["num_rows_total"])
    indices = choose_indices(
        total_rows,
        args.teams,
        args.team_size,
        args.seed,
        parse_indices(args.row_indices),
    )
    rows = retrieve_rows(indices, revision)
    check_participants(rows)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    check_output_directory(args.output_dir, args.teams)
    team_records = []
    for team_number in range(args.teams):
        team_id = f"team-{team_number + 1:03d}"
        start = team_number * args.team_size
        team_rows = rows[start : start + args.team_size]
        team = make_team(
            team_rows,
            team_id,
            args.variant,
            revision,
            args.seed,
        )
        filename = f"{team_id}.json"
        write_json(args.output_dir / filename, team)
        team_records.append(
            {
                "team_id": team_id,
                "file": filename,
                "row_indices": team["metadata"]["row_indices"],
                "participant_ids": team["metadata"]["participant_ids"],
            }
        )

    manifest = {
        "schema_version": "1.0",
        "source": "twin2k-500",
        "dataset": DATASET,
        "dataset_revision": revision,
        "dataset_config": CONFIG,
        "dataset_split": SPLIT,
        "persona_variant": args.variant,
        "selection_seed": args.seed,
        "team_size": args.team_size,
        "teams": team_records,
    }
    write_json(args.output_dir / "manifest.json", manifest)
    print(
        f"Wrote {args.teams} five-person team(s) using {args.variant} "
        f"from dataset revision {revision[:12]}."
    )


if __name__ == "__main__":
    main()
