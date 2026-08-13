import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(runnerRoot);

test("Empirica runtime contains five-person no-facilitator treatments only", async () => {
  const [treatments, server, survey] = await Promise.all([
    readFile(path.join(repoRoot, ".empirica", "treatments.yaml"), "utf8"),
    readFile(path.join(repoRoot, "server", "src", "callbacks.js"), "utf8"),
    readFile(
      path.join(repoRoot, "client", "src", "intro-exit", "SubjectiveSurvey.jsx"),
      "utf8",
    ),
  ]);

  assert.doesNotMatch(treatments, /value:\s*6\b/);
  assert.doesNotMatch(server, /OpenAI|Anthropic|facilitator prompt/i);
  assert.doesNotMatch(survey, /facilitator[A-Z]/);
  assert.equal(
    [...treatments.matchAll(/playerCount:\s*5/g)].length,
    2,
  );
});
