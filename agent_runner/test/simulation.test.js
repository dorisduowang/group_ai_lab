import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPersonas, loadTask } from "../src/config.js";
import { DryRunProvider } from "../src/provider.js";
import { computeMetrics, runSimulation } from "../src/simulation.js";

const runnerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(runnerRoot);

async function fixture() {
  const task = await loadTask({
    hptConfigPath: path.join(repoRoot, "server", "src", "HPTConfig.json"),
    factCatalogPath: path.join(runnerRoot, "config", "fact_catalog.json"),
  });
  return {
    task,
    personas: await loadPersonas(undefined, task.profiles),
    provider: new DryRunProvider(task),
  };
}

test("headless run has five independent participants and no facilitator", async () => {
  const setup = await fixture();
  const result = await runSimulation({
    ...setup,
    seed: 17,
    maxMessages: 15,
    runId: "test-17",
  });

  assert.equal(result.agents.length, 5);
  assert.equal(result.protocol.facilitator, false);
  assert.equal(result.messages.length, 15);
  assert.ok(result.messages.every((message) => message.sender_name !== "Facilitator"));
  assert.ok(result.final_choices.every((entry) => entry.choice));

  const profilesByAgent = new Map(
    result.agents.map((agent) => [agent.id, agent.private_profile]),
  );
  const taskProfiles = new Map(
    setup.task.profiles.map((profile) => [
      profile.name,
      new Set(profile.allowedFactIds),
    ]),
  );
  for (const message of result.messages) {
    const allowed = taskProfiles.get(profilesByAgent.get(message.sender_id));
    assert.ok(message.detected_fact_ids.every((id) => allowed.has(id)));
  }
});

test("same seed produces the same run record", async () => {
  const setup = await fixture();
  const first = await runSimulation({
    ...setup,
    seed: 9,
    maxMessages: 10,
    runId: "seed-9",
  });
  const second = await runSimulation({
    ...setup,
    seed: 9,
    maxMessages: 10,
    runId: "seed-9",
  });

  assert.deepEqual(first, second);
});

test("autonomous mode preserves wait and finish decisions without forcing turns", async () => {
  const setup = await fixture();
  const provider = {
    name: "decision-fixture",
    model: "fixture",
    temperature: 0,
    apiVersion: "test",
    async respond({ phase, agent }) {
      if (phase !== "public_action") {
        return { choice: "Eldoron", rationale: "Fixture choice." };
      }
      if (agent.index === 0) {
        return {
          action: "speak",
          message: "Eldoron has friendly and welcoming residents.",
          shared_fact_ids: ["E7", "X99"],
        };
      }
      return {
        action: agent.index === 1 ? "wait" : "finish",
        message: "",
        shared_fact_ids: [],
      };
    },
  };
  const factDetector = {
    name: "fixture-detector",
    model: "fixture",
    temperature: 0,
    apiVersion: "test",
    paperAligned: false,
    async detect({ messages }) {
      return {
        annotations: messages.map((message) => ({
          message_index: message.index,
          fact_ids: ["E7"],
        })),
      };
    },
  };
  const result = await runSimulation({
    task: setup.task,
    personas: setup.personas,
    provider,
    factDetector,
    seed: 2,
    maxMessages: 3,
    maxCycles: 2,
    minMessages: 1,
  });

  assert.equal(result.protocol.interaction, "autonomous");
  assert.ok(result.decision_log.some((entry) => entry.action === "wait"));
  assert.ok(result.decision_log.some((entry) => entry.action === "finish"));
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[0].detected_fact_ids, ["E7"]);
  assert.ok(
    result.fact_detection_audit.unauthorized_declarations.some(
      (entry) => entry.unauthorized_declared_fact_ids.length === 1,
    ),
  );
});

test("metrics use detector annotations rather than participant declarations", () => {
  const messages = [
    {
      sender_id: "agent-1",
      declared_fact_ids: ["E7"],
      detected_fact_ids: [],
    },
    {
      sender_id: "agent-2",
      declared_fact_ids: [],
      detected_fact_ids: ["C8"],
    },
  ];
  const facts = new Map([
    ["E7", { city: "Eldoron" }],
    ["C8", { city: "Cragnio" }],
  ]);
  const metrics = computeMetrics(
    messages,
    [
      { choice: "Cragnio" },
      { choice: "Cragnio" },
    ],
    facts,
    ["agent-1", "agent-2"],
  );

  assert.equal(metrics.n_total_facts_mentioned, 1);
  assert.equal(metrics.n_eldoron_facts, 0);
  assert.equal(metrics.n_cragnio_facts, 1);
  assert.equal(metrics.all_members_contributed_fact, false);
});
