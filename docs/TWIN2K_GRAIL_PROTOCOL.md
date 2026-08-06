# Twin-2K-500 teams in GRAIL

The base Twin-2K-500 dataset contains the survey history used for each twin.
The Mega Study contains later questions and responses. Its `survey_text` and
`survey_json_with_human_response` fields are outcomes, so they do not belong in
a GRAIL persona.

The adapter reads `full_persona` from the base dataset. It accepts the complete
survey text, the shorter summary, or the structured JSON. Complete text is the
default used for the main condition. Summary personas are a separate pilot
condition.

## Build teams

```bash
python3 analysis/build_twin2k_teams.py \
  --output-dir data/twin2k-teams \
  --teams 4 \
  --seed 100 \
  --variant persona_text
```

The seed selects distinct dataset rows and assigns them to five-person teams.
The manifest records the dataset revision, row offsets, participant IDs, persona
variant, and team membership. Pass `--row-indices` with the recorded offsets to
rebuild the same teams even if the selection code later changes.

The builder pins its row requests to the recorded dataset revision and rejects
missing or repeated participant IDs.

The generated files contain individual survey histories. They are ignored by
Git and should stay out of shared logs even though the source dataset is public.

## Run matched group compositions

Use the same GRAIL seed sequence for every team. This holds private-report
assignment and publication randomization constant while team composition
changes.

```bash
for team in data/twin2k-teams/team-*.json; do
  team_id=$(basename "$team" .json)
  node agent_runner/src/cli.js \
    --provider openai \
    --model gpt-5-mini \
    --temperature 0 \
    --fact-detector openai \
    --detector-model gpt-4o \
    --personas "$team" \
    --runs 5 \
    --seed 100 \
    --experiment-id "twin2k-$team_id" \
    --output-dir "runs/twin2k/$team_id" \
    --quiet
done
```

Summarize the matched compositions after all team directories finish:

```bash
python3 analysis/summarize_twin2k_groups.py \
  --agent-runs runs/twin2k \
  --output runs/twin2k-composition-summary
```

The summary command stops when seed sets or team membership do not match.

Run records include the persona file hash, dataset revision, persona variant,
team ID, and participant IDs. The private GRAIL report remains separate from
the survey profile. Each model call receives one twin profile, one private
report, and the public transcript only.

Compare message count, unique facts, fact density, contribution balance, final
choice, and unanimity across teams. The public GRAIL data are a descriptive
reference. The Twin-2K participants did not complete GRAIL, so these runs do
not test whether a twin predicts its source participant.

Sources:

- Twin-2K-500 paper: <https://arxiv.org/abs/2505.17479>
- Twin-2K-500 data: <https://huggingface.co/datasets/LLM-Digital-Twin/Twin-2K-500>
- Mega Study paper: <https://arxiv.org/abs/2509.19088>
- Mega Study data: <https://huggingface.co/datasets/LLM-Digital-Twin/Twin-2K-500-Mega-Study>
- Mega Study code: <https://github.com/TianyiPeng/Twin-2K-500-Mega-Study>
