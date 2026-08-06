import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPersonaConfig, loadPersonas, loadTask } from "../src/config.js";

const runnerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(runnerRoot);

test("every partial-report bullet maps to the preregistered fact catalog", async () => {
  const task = await loadTask({
    hptConfigPath: path.join(repoRoot, "server", "src", "HPTConfig.json"),
    factCatalogPath: path.join(runnerRoot, "config", "fact_catalog.json"),
  });

  assert.equal(task.facts.length, 30);
  assert.equal(task.profiles.length, 5);
  assert.deepEqual(
    task.profiles.map((profile) => profile.facts.length),
    [14, 14, 14, 15, 14],
  );
  for (const profile of task.profiles) {
    assert.equal(
      new Set(profile.allowedFactIds).size,
      profile.allowedFactIds.length,
    );
  }
});

test("SimulaCrew-style agent fields become private persona prompts", async () => {
  const profiles = [
    { name: "Green" },
    { name: "Blue" },
    { name: "Pink" },
    { name: "Red" },
    { name: "Orange" },
  ];
  const personas = await loadPersonas(
    path.join(runnerRoot, "config", "simulacrew-personas.example.json"),
    profiles,
  );

  assert.equal(personas.length, 5);
  assert.equal(personas[0].source, "simulacrew");
  assert.match(personas[0].prompt, /experimental design/);
  assert.match(personas[0].prompt, /assertiveness=6/);
});

test("configured condition rejects incomplete or empty persona records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "persona-test-"));
  const pathname = path.join(directory, "invalid.json");
  await writeFile(
    pathname,
    JSON.stringify({
      agents: Array.from({ length: 5 }, (_, index) => ({
        id: `agent-${index + 1}`,
        name: `Agent ${index + 1}`,
      })),
    }),
  );
  const profiles = Array.from({ length: 5 }, (_, index) => ({
    name: `Profile ${index + 1}`,
  }));

  await assert.rejects(
    loadPersonas(pathname, profiles),
    /contains no supported SimulaCrew persona fields/,
  );
});

test("Twin-2K configs retain participant and dataset provenance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "twin2k-test-"));
  const pathname = path.join(directory, "team.json");
  await writeFile(
    pathname,
    JSON.stringify({
      metadata: {
        source: "twin2k-500",
        dataset_revision: "revision-123",
        persona_variant: "persona_summary",
      },
      agents: Array.from({ length: 5 }, (_, index) => ({
        id: `twin-${index + 1}`,
        name: `Twin ${index + 1}`,
        participant_id: String(100 + index),
        base_prompt: `Survey profile ${index + 1}`,
      })),
    }),
  );
  const profiles = Array.from({ length: 5 }, (_, index) => ({
    name: `Profile ${index + 1}`,
  }));

  const loaded = await loadPersonaConfig(pathname, profiles);
  assert.equal(loaded.metadata.source, "twin2k-500");
  assert.equal(loaded.metadata.dataset_revision, "revision-123");
  assert.equal(loaded.personas[0].participantId, "100");
  assert.equal(loaded.personas[0].source, "twin2k-500");
});
