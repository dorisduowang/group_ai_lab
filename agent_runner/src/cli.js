#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPersonaConfig, loadTask } from "./config.js";
import {
  AnthropicFactDetector,
  AnthropicMessagesProvider,
  DeclaredFactDetector,
  DryRunProvider,
  OpenAIFactDetector,
  OpenAIResponsesProvider,
} from "./provider.js";
import { DEFAULT_SEED, runSimulation } from "./simulation.js";

const runnerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(runnerRoot);

function usage() {
  return `Usage:
  node agent_runner/src/cli.js [options]

Options:
  --provider BACKEND              dry-run, openai, or anthropic (default: dry-run)
  --model MODEL                   Provider model; otherwise uses its environment default
  --runs N                        Number of independent groups (default: 1)
  --seed N                        First random seed (default: ${DEFAULT_SEED})
  --min-messages N                Quality target, not a forced floor (default: 5)
  --max-messages N                Hard public-message ceiling (default: 15)
  --max-cycles N                  Autonomous decision pulses (default: 10)
  --temperature N                 Participant sampling temperature (default: 0)
  --fact-detector BACKEND         declared, openai, or anthropic
                                  (default: provider backend; dry-run uses declared)
  --detector-model MODEL          Model used for post-hoc fact detection
  --personas PATH                 SimulaCrew-compatible config with agents[]
  --hidden-info-cue               Tell agents that reports may differ
  --full-info                     Give every agent the full-information report
  --output-dir PATH               Output directory (default: runs/agent-simulations)
  --experiment-id ID              Stable label used in filenames (default: agent-study)
  --quiet                         Do not print message transcripts
  --help                          Show this message

Live OpenAI runs require OPENAI_API_KEY; Anthropic runs require
ANTHROPIC_API_KEY. Each agent call is stateless and receives only that agent's
private report plus the public transcript. No facilitator is used.`;
}

function parseArgs(argv) {
  const options = {
    provider: "dry-run",
    runs: 1,
    seed: DEFAULT_SEED,
    minMessages: 5,
    maxMessages: 15,
    maxCycles: 10,
    temperature: 0,
    hiddenInfoCue: false,
    fullInfo: false,
    quiet: false,
    experimentId: "agent-study",
    outputDir: path.join(repoRoot, "runs", "agent-simulations"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (arg === "--help") options.help = true;
    else if (arg === "--provider") options.provider = next();
    else if (arg === "--model") options.model = next();
    else if (arg === "--runs") options.runs = Number.parseInt(next(), 10);
    else if (arg === "--seed") options.seed = Number.parseInt(next(), 10);
    else if (arg === "--min-messages") {
      options.minMessages = Number.parseInt(next(), 10);
    } else if (arg === "--max-messages") {
      options.maxMessages = Number.parseInt(next(), 10);
    } else if (arg === "--max-cycles") {
      options.maxCycles = Number.parseInt(next(), 10);
    } else if (arg === "--temperature") {
      options.temperature = Number.parseFloat(next());
    } else if (arg === "--fact-detector") options.factDetector = next();
    else if (arg === "--detector-model") options.detectorModel = next();
    else if (arg === "--personas") options.personas = path.resolve(next());
    else if (arg === "--output-dir") options.outputDir = path.resolve(next());
    else if (arg === "--experiment-id") options.experimentId = next();
    else if (arg === "--hidden-info-cue") options.hiddenInfoCue = true;
    else if (arg === "--full-info") options.fullInfo = true;
    else if (arg === "--quiet") options.quiet = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  for (const [name, value] of [
    ["--runs", options.runs],
    ["--seed", options.seed],
    ["--min-messages", options.minMessages],
    ["--max-messages", options.maxMessages],
    ["--max-cycles", options.maxCycles],
  ]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  if (!["dry-run", "openai", "anthropic"].includes(options.provider)) {
    throw new Error("--provider must be dry-run, openai, or anthropic.");
  }
  if (
    !Number.isFinite(options.temperature) ||
    options.temperature < 0 ||
    options.temperature > 2
  ) {
    throw new Error("--temperature must be between 0 and 2.");
  }
  if (options.provider === "anthropic" && options.temperature > 1) {
    throw new Error("--temperature must be between 0 and 1 for Anthropic.");
  }
  if (options.minMessages > options.maxMessages) {
    throw new Error("--min-messages cannot exceed --max-messages.");
  }
  if (
    options.factDetector &&
    !["declared", "openai", "anthropic"].includes(options.factDetector)
  ) {
    throw new Error("--fact-detector must be declared, openai, or anthropic.");
  }
  if (options.experimentId && !/^[A-Za-z0-9._-]+$/.test(options.experimentId)) {
    throw new Error(
      "--experiment-id may contain only letters, numbers, dot, underscore, and hyphen.",
    );
  }
  return options;
}

function mean(results, key) {
  return (
    results.reduce((sum, result) => sum + Number(result.metrics[key]), 0) /
    results.length
  );
}

function aggregate(results) {
  const protocol = results[0].protocol;
  const personaSources = [
    ...new Set(
      results.flatMap((result) =>
        result.agents.map((agent) => agent.persona_source),
      ),
    ),
  ];
  return {
    groups: results.length,
    provider: protocol.provider,
    model: protocol.model,
    temperature: protocol.temperature,
    fact_detector: protocol.fact_detector,
    fact_detector_model: protocol.fact_detector_model,
    facilitator: false,
    persona_sources: personaSources,
    mean_n_messages_no_facilitator: mean(results, "n_messages_no_facilitator"),
    mean_n_total_facts_mentioned: mean(results, "n_total_facts_mentioned"),
    mean_fact_density: mean(results, "fact_density"),
    mean_options_gini_coef: mean(results, "options_gini_coef"),
    proportion_chose_eldoron: mean(results, "chose_eldoron"),
    proportion_unanimous: mean(results, "unanimous"),
    proportion_all_members_contributed_fact: mean(
      results,
      "all_members_contributed_fact",
    ),
  };
}

function createProvider(options, task) {
  const settings = {
    model: options.model,
    temperature: options.temperature,
  };
  if (options.provider === "openai") {
    return new OpenAIResponsesProvider(settings);
  }
  if (options.provider === "anthropic") {
    return new AnthropicMessagesProvider(settings);
  }
  return new DryRunProvider(task);
}

function createDetector(options) {
  const backend =
    options.factDetector ||
    (options.provider === "dry-run" ? "declared" : options.provider);
  if (backend === "openai") {
    return new OpenAIFactDetector({ model: options.detectorModel });
  }
  if (backend === "anthropic") {
    return new AnthropicFactDetector({ model: options.detectorModel });
  }
  return new DeclaredFactDetector();
}

async function sha256(pathname) {
  const bytes = await readFile(pathname);
  return createHash("sha256").update(bytes).digest("hex");
}

function writeJson(pathname, value) {
  return writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const hptConfigPath = path.join(repoRoot, "server", "src", "HPTConfig.json");
  const factCatalogPath = path.join(runnerRoot, "config", "fact_catalog.json");
  const task = await loadTask({
    hptConfigPath,
    factCatalogPath,
    fullInfo: options.fullInfo,
  });
  const personaConfig = await loadPersonaConfig(options.personas, task.profiles);
  const personas = personaConfig.personas;
  const provider = createProvider(options, task);
  const factDetector = createDetector(options);
  const reproducibility = {
    hpt_config_sha256: await sha256(hptConfigPath),
    fact_catalog_sha256: await sha256(factCatalogPath),
    persona_mode: options.personas ? personaConfig.metadata.source : "neutral",
    persona_config_filename: options.personas
      ? path.basename(options.personas)
      : null,
    persona_config_sha256: options.personas
      ? await sha256(options.personas)
      : null,
    persona_metadata: personaConfig.metadata,
  };

  await mkdir(options.outputDir, { recursive: true });
  const results = [];
  const experimentId = options.experimentId;

  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    const seed = options.seed + runIndex;
    const runId = `${experimentId}-${options.provider}-${seed}`;
    const result = await runSimulation({
      task,
      personas,
      provider,
      factDetector,
      seed,
      minMessages: options.minMessages,
      maxMessages: options.maxMessages,
      maxCycles: options.maxCycles,
      hiddenInfoCue: options.hiddenInfoCue,
      runId,
      reproducibility,
    });
    results.push(result);
    const outputPath = path.join(options.outputDir, `${runId}.json`);
    await writeJson(outputPath, result);

    console.log(
      `${runId}: ${result.metrics.group_selection}; ${result.metrics.n_total_facts_mentioned} unique facts; ${result.messages.length} messages`,
    );
    if (!options.quiet) {
      for (const message of result.messages) {
        console.log(`${message.sender_name}: ${message.text}`);
      }
    }
  }

  const summary = aggregate(results);
  const manifest = {
    schema_version: "1.0",
    experiment_id: experimentId,
    run_ids: results.map((result) => result.run_id),
    output_files: results.map((result) => `${result.run_id}.json`),
    config: {
      provider: options.provider,
      model: provider.model,
      min_messages: options.minMessages,
      max_messages: options.maxMessages,
      max_cycles: options.maxCycles,
      temperature: provider.temperature,
      max_output_tokens: provider.maxOutputTokens ?? null,
      fact_detector: factDetector.name,
      fact_detector_model: factDetector.model,
      fact_detector_temperature: factDetector.temperature,
      fact_detector_max_output_tokens:
        factDetector.maxOutputTokens ?? null,
      persona_mode: reproducibility.persona_mode,
      persona_config_filename: reproducibility.persona_config_filename,
      persona_config_sha256: reproducibility.persona_config_sha256,
      persona_metadata: reproducibility.persona_metadata,
      hpt_config_sha256: reproducibility.hpt_config_sha256,
      fact_catalog_sha256: reproducibility.fact_catalog_sha256,
      hidden_info_cue: options.hiddenInfoCue,
      full_info: options.fullInfo,
      first_seed: options.seed,
      runs: options.runs,
    },
    summary,
  };
  await writeJson(
    path.join(options.outputDir, `${experimentId}-manifest.json`),
    manifest,
  );
  console.log(
    `Saved ${results.length} run(s) and ${experimentId}-manifest.json to ${options.outputDir}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
