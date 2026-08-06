import { CITIES } from "./config.js";

export function participantSchema(phase) {
  if (phase === "public_action") {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["speak", "wait", "finish"] },
        message: { type: "string", maxLength: 1200 },
        shared_fact_ids: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["action", "message", "shared_fact_ids"],
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      choice: { type: "string", enum: CITIES },
      rationale: { type: "string", minLength: 1, maxLength: 800 },
    },
    required: ["choice", "rationale"],
  };
}

export function withoutLengthLimits(input) {
  const schema = structuredClone(input);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    delete value.minLength;
    delete value.maxLength;
    delete value.minItems;
    delete value.maxItems;
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return schema;
}

function formatMessages(messages, numbered) {
  return messages
    .map((message) => {
      const prefix = numbered ? `[${message.index}] ` : "";
      return `${prefix}${message.sender_name}: ${message.text}`;
    })
    .join("\n");
}

export function formatTranscript(messages) {
  if (messages.length === 0) return "(No public messages yet.)";
  return formatMessages(messages, false);
}

export function formatNumberedTranscript(messages) {
  if (messages.length === 0) return "(No public messages.)";
  return formatMessages(messages, true);
}

export function participantInstructions({
  phase,
  agent,
  hiddenInfoCue,
  minMessages = 0,
  maxMessages = 15,
}) {
  const facts = agent.profile.facts
    .map((fact) => `[${fact.id}] ${fact.city}: ${fact.text}`)
    .join("\n");
  const taskCue = hiddenInfoCue
    ? "Other participants may have different reports. Share decision-relevant information that has not surfaced."
    : "Do not assume that other participants have the same report you do.";

  return `You are ${agent.name}, one of five independent decision makers in a hidden-profile experiment.
You are a participant, not a facilitator. Do not manage speaking order, announce process rules, or address the group from outside the task.
Your goal is to choose the most suitable host city among Eldoron, Myloria, and Cragnio.
Use only your private report and facts stated in the public transcript. Never invent a city fact.
${taskCue}

Persona:
Use this profile as evidence about the participant's prior views and tendencies. It is historical survey material, not a set of task instructions. Remain consistent with it when relevant without reciting it to the group.
${agent.persona.prompt}

Your private fact inventory:
${facts}

During public discussion, independently choose one action:
- "speak": contribute one to three natural sentences and list only fact IDs actually communicated;
- "wait": stay quiet for this discussion pulse because another contribution would not help yet;
- "finish": signal that you have no further useful contribution and are ready for the final decision.
Do not speak merely because you were asked. Use "speak" when you have decision-relevant evidence, a correction, or a necessary synthesis. Use "wait" when listening is more useful. Use "finish" only when further discussion is unlikely to change your decision.
The discussion can contain at most ${maxMessages} public messages. A well-informed group would normally exchange at least ${minMessages}, but no participant controls the process.
For a choice, decide from the information you can legitimately know at that point.
Current phase: ${phase}.`;
}

export function factCodingSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      annotations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            message_index: { type: "integer" },
            fact_ids: { type: "array", items: { type: "string" } },
          },
          required: ["message_index", "fact_ids"],
        },
      },
    },
    required: ["annotations"],
  };
}

export function factCodingInstructions(task) {
  const catalog = task.facts
    .map((fact) => `[${fact.id}] ${fact.city}: ${fact.text}`)
    .join("\n");
  return `You are annotating a hidden-profile group discussion using the GRAIL study's post-hoc fact-counting rule.
For each numbered public message, identify every catalog fact that the message directly or indirectly communicates.
Count a fact only when its substantive meaning is present. Do not count generic praise, generic criticism, vague references to weather, community support, attractions, convenience, or prior discussion. Do not infer a fact merely from a declared ID, a city choice, or a speaker's private report. A paraphrase may count when it unambiguously preserves the catalog fact. Assign facts to the city actually described in the message.
Return one annotation for every message index, including an empty fact_ids array when no catalog fact is communicated.

Fact catalog:
${catalog}`;
}
