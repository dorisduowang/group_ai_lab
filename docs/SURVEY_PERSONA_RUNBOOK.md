# Survey-persona runbook

This runbook starts from an authorized survey export. Do not place raw survey
responses, service-account credentials, uploaded CV text, or generated
respondent personas in this repository.

## 1. Generate the SimulaCrew config

```bash
git clone https://github.com/prashaantr/SimulaCrew.git
python3 -m venv SimulaCrew/.venv
SimulaCrew/.venv/bin/pip install -e SimulaCrew

SimulaCrew/.venv/bin/simulacrew ingest-survey responses.csv \
  --output survey-team.json \
  --topic "Choose the most suitable host city from the assigned evidence."
```

For a private Google Sheet:

```bash
SimulaCrew/.venv/bin/simulacrew ingest-google-survey \
  "https://docs.google.com/spreadsheets/d/SHEET_ID/edit?gid=TAB_ID" \
  --credentials-file service-account.json \
  --output survey-team.json \
  --topic "Choose the most suitable host city from the assigned evidence."
```

## 2. Preflight the persona file

The generated JSON must contain:

- `metadata.source` equal to `survey-ingestion`;
- exactly five agents;
- five distinct respondent IDs;
- no empty agent prompt assembled from a blank row; and
- only respondents whose use is authorized for this study.

The runner enforces the five-agent count. Keep a SHA-256 checksum of the file;
the run manifest records the same checksum without storing its contents.

## 3. Run paired conditions

Use the same model, detector, parameters, and seeds in both conditions:

```bash
export ANTHROPIC_API_KEY="set this in the shell; never commit it"

node agent_runner/src/cli.js \
  --provider anthropic \
  --model claude-haiku-4-5-20251001 \
  --temperature 0 \
  --fact-detector anthropic \
  --detector-model claude-sonnet-5 \
  --runs 5 \
  --seed 100 \
  --min-messages 10 \
  --max-messages 30 \
  --max-cycles 8 \
  --experiment-id survey-persona-claude \
  --personas /secure/path/survey-team.json \
  --output-dir runs/survey-persona-claude \
  --quiet
```

For method alignment with the released human fact annotations, use
`--fact-detector openai --detector-model gpt-4o` and provide
`OPENAI_API_KEY`.

## 4. Accept or quarantine each run

Before analysis, require:

- `minimum_message_target_met = true`;
- `all_five_agents_spoke = true`;
- `detector_annotated_every_message = true`;
- `no_unknown_detected_fact_ids = true`; and
- `no_first_mention_source_violations = true`.

Do not silently discard a failed run. Preserve it, record the failure reason,
and apply the predeclared replacement rule.

## 5. Compare descriptively

```bash
python3 analysis/compare_to_grail.py \
  --osf-data /secure/path/osf-grail-data \
  --agent-runs runs/survey-persona-claude \
  --output runs/survey-persona-claude-comparison
```

Use the group as the unit of analysis. Report detector method differences,
message/cycle ceilings, failed-run handling, and uncertainty across groups. Do
not describe the OSF comparison as a benchmark of model quality or as evidence
that a persona predicts its source respondent.
