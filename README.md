# GRAIL without an LLM facilitator

This fork removes the LLM facilitator from the released GRAIL hidden profile
experiment and adds a local runner for groups of five model participants.
The task, private reports, response options, and hidden information cue are
unchanged from the upstream repository.

Upstream code: <https://github.com/microsoft/group_ai_lab>

Paper and public data: <https://osf.io/ervnb/overview>

## Changes from upstream

The Empirica app now contains only the no facilitator treatments. Facilitator
configuration, callbacks, interface elements, and exit questions have been
removed.

The headless runner in `agent_runner` gives each participant one private report
and the public transcript. Participants independently choose whether to speak,
wait, or finish. Calls in the same discussion cycle use the same transcript
snapshot, so no participant sees another participant's decision before making
its own.

Participant declarations about shared facts are saved for auditing but are not
used as measurements. A separate detector codes the transcript, and the group
metrics are calculated from those annotations.

## Run the Empirica app

Install Empirica 1.12, then install the client and server packages.

```bash
curl -fsS https://install.empirica.dev | sh
npm ci --prefix client
npm ci --prefix server
cp .empirica/empirica.toml.example .empirica/empirica.toml
```

Set the local token and admin password in `.empirica/empirica.toml`, then run:

```bash
empirica
```

Open <http://localhost:3000/admin>, create a batch with either no facilitator
treatment, and join with five participant tabs. The Empirica server does not
need a model API key.

## Run model participants

The runner requires Node 20 or later and has no npm dependencies. A deterministic
smoke test can be run without an API key.

```bash
node agent_runner/src/cli.js \
  --provider dry-run \
  --runs 5 \
  --seed 100 \
  --min-messages 10 \
  --max-messages 30 \
  --max-cycles 10 \
  --experiment-id neutral-smoke \
  --output-dir runs/neutral-smoke \
  --quiet
```

For OpenAI:

```bash
export OPENAI_API_KEY="..."

node agent_runner/src/cli.js \
  --provider openai \
  --model gpt-5-mini \
  --temperature 0 \
  --fact-detector openai \
  --detector-model gpt-4o \
  --runs 5 \
  --seed 100 \
  --min-messages 10 \
  --max-messages 30 \
  --max-cycles 10 \
  --experiment-id neutral-openai \
  --output-dir runs/neutral-openai
```

For Anthropic:

```bash
export ANTHROPIC_API_KEY="..."

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
  --max-cycles 10 \
  --experiment-id neutral-anthropic \
  --output-dir runs/neutral-anthropic
```

The default seed is 100. For multiple groups, the runner uses consecutive
seeds beginning with the supplied value. The seed fixes report assignment,
publication order, and deterministic provider behavior. A fixed model snapshot
and temperature zero reduce variation in live runs, but external model APIs do
not guarantee identical completions.

Run records and analysis outputs are written under `runs` by default and are
ignored by Git. Each record includes the seed, model settings, task and persona
hashes, response metadata, decisions, transcript annotations, quality checks,
and group metrics.

Use `--hidden-info-cue` to match the paper's message condition. The default is
the no cue control condition.

## Use SimulaCrew personas

The `--personas` option accepts a SimulaCrew configuration with an `agents`
array. The file must contain exactly five distinct agents with nonempty persona
fields. Partial personalization is rejected so that neutral and personalized
participants are not mixed in one condition.

```bash
node agent_runner/src/cli.js \
  --provider openai \
  --model gpt-5-mini \
  --temperature 0 \
  --fact-detector openai \
  --detector-model gpt-4o \
  --personas /absolute/path/to/survey-team.json \
  --runs 5 \
  --seed 100 \
  --experiment-id survey-personas \
  --output-dir runs/survey-personas
```

`agent_runner/config/simulacrew-personas.example.json` documents the accepted
shape. It contains synthetic examples and should not be used as survey data.
Persona assignment and private report assignment remain separate.

See `docs/SURVEY_PERSONA_RUNBOOK.md` for the private data checks and paired run
procedure.

## Use Twin-2K-500 digital twins

Build five-person teams directly from the public Twin-2K-500 survey profiles.
The default uses the complete survey text. Generated profiles are stored in an
ignored directory.

```bash
python3 analysis/build_twin2k_teams.py \
  --output-dir data/twin2k-teams \
  --teams 4 \
  --seed 100 \
  --variant persona_text
```

Each team file can be passed to `--personas`. Use the same runner seeds across
teams to change team composition while keeping GRAIL report assignment fixed.
The team manifest records the exact dataset revision, row offsets, participant
IDs, and persona variant. See `docs/TWIN2K_GRAIL_PROTOCOL.md` for the matched
run procedure and interpretation limits.

After running several teams, `analysis/summarize_twin2k_groups.py` compares the
same GRAIL seed sequence across compositions and refuses unmatched designs.

## Compare with GRAIL data

Download the required public files and compare one run directory with the
matching human condition.

```bash
bash analysis/download_osf_benchmark.sh data/osf-grail

python3 analysis/compare_to_grail.py \
  --osf-data data/osf-grail \
  --agent-runs runs/neutral-openai \
  --output runs/neutral-openai-comparison
```

The comparison script applies the released validity rules and should recover
281 human groups. Agent comparisons are descriptive. They are not matched human
counterfactuals, and detector differences should be reported when the agent
transcripts are not coded with the same method as the human transcripts.

## Tests

```bash
npm test --prefix agent_runner
python3 -m unittest discover -s analysis -p 'test_*.py'
npm run build --prefix client
npm run build --prefix server
```

Do not commit API keys, raw survey responses, participant identifiers, OSF data,
or generated outputs. The upstream code is released under the MIT License. See
`LICENSE`.
