import { readFile } from "node:fs/promises";

export const CITIES = ["Eldoron", "Myloria", "Cragnio"];

export function normalizeFactText(value) {
  return value
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[.!]\s*$/, "")
    .trim();
}

export function extractMarkdownFacts(markdown) {
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("* "))
    .map((line) => line.slice(2).trim());
}

export async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadTask({ hptConfigPath, factCatalogPath, fullInfo = false }) {
  const [taskConfig, facts] = await Promise.all([
    loadJson(hptConfigPath),
    loadJson(factCatalogPath),
  ]);

  const byText = new Map(
    facts.map((fact) => [normalizeFactText(fact.text), fact]),
  );

  const profiles = taskConfig.playerConfig.map((profile) => {
    const content = fullInfo
      ? profile.playerContent_fullinfo
      : profile.playerContent;
    const markdownFacts = extractMarkdownFacts(content);
    const matchedFacts = markdownFacts.map((text) => {
      const fact = byText.get(normalizeFactText(text));
      if (!fact) {
        throw new Error(
          `Could not map "${text}" from ${profile.playerName}'s report to the fact catalog.`,
        );
      }
      return fact;
    });

    return {
      id: profile.playerName.toLowerCase(),
      name: profile.playerName,
      hexCode: profile.hexCode,
      content,
      facts: matchedFacts,
      allowedFactIds: matchedFacts.map((fact) => fact.id),
    };
  });

  if (profiles.length !== 5) {
    throw new Error(`The hidden-profile task requires 5 profiles; found ${profiles.length}.`);
  }

  return {
    generalInfo: taskConfig.generalInfo,
    profiles,
    facts,
    factsById: new Map(facts.map((fact) => [fact.id, fact])),
  };
}

function section(label, value) {
  const text = Array.isArray(value) ? value.filter(Boolean).join("; ") : value;
  return text ? `${label}: ${text}` : null;
}

export function personaToPrompt(agent) {
  const sections = [
    agent.base_prompt,
    section("Background", agent.backstory),
    section("Speaking style", agent.speaking_style),
    section("Knowledge", agent.knowledge),
    section("Skills", agent.skills),
    section("Interests", agent.interests),
    section("Relevant history", agent.history),
    section(
      "Personality scores",
      agent.personality &&
        Object.entries(agent.personality)
          .map(([key, value]) => `${key}=${value}`)
          .join(", "),
    ),
    section("Goals", agent.goals),
    section("Constraints", agent.constraints),
  ];

  return sections.filter(Boolean).join("\n");
}

const neutralStyles = [
  "Be concise and evidence-led.",
  "Look for trade-offs and ask what evidence is still missing.",
  "Synthesize points across cities without dominating the discussion.",
  "Be willing to disagree when the facts support it.",
  "Keep the group focused on reaching a defensible choice.",
];

export async function loadPersonaConfig(path, profiles) {
  if (!path) {
    return {
      metadata: { source: "unpersonalized" },
      personas: profiles.map((profile, index) => ({
        id: `neutral-${index + 1}`,
        name: profile.name,
        prompt: neutralStyles[index % neutralStyles.length],
        source: "unpersonalized",
      })),
    };
  }

  const source = await loadJson(path);
  const agents = Array.isArray(source) ? source : source.agents;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error("Persona file must be an array or an object with an agents array.");
  }
  if (agents.length !== profiles.length) {
    throw new Error(
      `Persona file must contain exactly ${profiles.length} agents; found ${agents.length}. ` +
        "Partial personalization is not allowed because it confounds the study condition.",
    );
  }
  const personaIds = agents.map((agent, index) =>
    String(agent.id || agent.name || `persona-${index + 1}`),
  );
  if (new Set(personaIds).size !== personaIds.length) {
    throw new Error(
      "Persona file must contain five distinct agent IDs or names.",
    );
  }
  const personaPrompts = agents.map(personaToPrompt);
  const emptyPromptIndex = personaPrompts.findIndex((prompt) => !prompt.trim());
  if (emptyPromptIndex !== -1) {
    throw new Error(
      `Persona ${emptyPromptIndex + 1} contains no supported SimulaCrew persona fields.`,
    );
  }
  const metadata = Array.isArray(source) ? {} : source.metadata || {};
  const sourceTypes = {
    "survey-ingestion": "simulacrew-survey",
    "twin2k-500": "twin2k-500",
  };
  const sourceType = sourceTypes[metadata.source] || "simulacrew";

  return {
    metadata: { ...metadata, source: sourceType },
    personas: profiles.map((profile, index) => {
      const agent = agents[index];
      return {
        id: agent.id || `persona-${index + 1}`,
        name: profile.name,
        sourceName: agent.name || agent.id || `Persona ${index + 1}`,
        participantId: agent.participant_id || null,
        prompt: personaPrompts[index],
        source: sourceType,
      };
    }),
  };
}

export async function loadPersonas(path, profiles) {
  return (await loadPersonaConfig(path, profiles)).personas;
}
