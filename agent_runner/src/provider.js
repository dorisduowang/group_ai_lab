import { CITIES } from "./config.js";
import {
  factCodingInstructions,
  factCodingSchema,
  formatNumberedTranscript,
  formatTranscript,
  participantInstructions,
  participantSchema,
  withoutLengthLimits,
} from "./prompts.js";

function scoreFacts(facts) {
  const scores = Object.fromEntries(CITIES.map((city) => [city, 0]));
  for (const fact of facts) {
    if (fact.polarity === "Positive") scores[fact.city] += 1;
    if (fact.polarity === "Negative") scores[fact.city] -= 1;
  }
  return scores;
}

function chooseCity(facts) {
  const scores = scoreFacts(facts);
  return CITIES.reduce((best, city) =>
    scores[city] > scores[best] ? city : best,
  );
}

function interpretation(fact) {
  if (fact.polarity === "Positive") {
    return `That is a point in ${fact.city}'s favor.`;
  }
  if (fact.polarity === "Negative") {
    return `That is a real drawback for ${fact.city}.`;
  }
  return "It may not decide the outcome, but it belongs in the comparison.";
}

export class DryRunProvider {
  constructor(task, { temperature = 0 } = {}) {
    this.task = task;
    this.name = "dry-run";
    this.model = "deterministic-hidden-profile-baseline";
    this.temperature = temperature;
    this.apiVersion = "local";
  }

  async respond({ phase, agent, transcript, turnIndex = 0 }) {
    const publicFactIds = new Set(
      transcript.flatMap(
        (message) =>
          message.detected_fact_ids ||
          message.authorized_declared_fact_ids ||
          message.shared_fact_ids ||
          [],
      ),
    );
    const knownFactIds = new Set([
      ...agent.profile.allowedFactIds,
      ...publicFactIds,
    ]);
    const knownFacts = [...knownFactIds].map((id) => this.task.factsById.get(id));

    if (phase === "pre_choice") {
      const choice = chooseCity(agent.profile.facts);
      return {
        choice,
        rationale: `Based only on ${agent.name}'s initial report, ${choice} has the strongest positive-minus-negative balance.`,
      };
    }

    if (phase === "final_choice") {
      const choice = chooseCity(knownFacts);
      return {
        choice,
        rationale: `${choice} has the strongest balance in the facts this agent could legitimately know after discussion.`,
      };
    }

    const candidates = agent.profile.facts
      .filter((fact) => !publicFactIds.has(fact.id))
      .sort((a, b) => {
        const visibility = { Private: 0, Shared: 1, Public: 2 };
        return (
          visibility[a.visibility] - visibility[b.visibility] ||
          a.id.localeCompare(b.id, undefined, { numeric: true })
        );
      });

    if (candidates.length === 0) {
      return {
        action: "finish",
        message: "",
        shared_fact_ids: [],
      };
    }

    const offset = (turnIndex + agent.index) % candidates.length;
    const selected = candidates.slice(offset, offset + 2);
    if (selected.length < Math.min(2, candidates.length)) {
      selected.push(...candidates.slice(0, 2 - selected.length));
    }

    return {
      action: "speak",
      message: selected
        .map((fact) => `${fact.city}: ${fact.text}. ${interpretation(fact)}`)
        .join(" "),
      shared_fact_ids: selected.map((fact) => fact.id),
    };
  }
}

function responseText(payload) {
  const chunks = [];
  for (const item of payload.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function anthropicResponseText(payload) {
  return (payload.content || [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n")
    .trim();
}

async function postJson({
  fetchImpl,
  endpoint,
  headers,
  request,
  label,
}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });
      const body = await response.json();
      if (!response.ok) {
        const message =
          body?.error?.message || `${response.status} ${response.statusText}`;
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 750));
          continue;
        }
        throw new Error(`${label} error: ${message}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < 3 && error instanceof TypeError) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
        continue;
      }
      break;
    }
  }
  throw lastError;
}

function responseMetadata(body, apiVersion) {
  return {
    response_id: body.id || null,
    response_model: body.model || null,
    stop_reason:
      body.stop_reason || body.status || body.incomplete_details?.reason || null,
    usage: body.usage || null,
    api_version: apiVersion,
  };
}

export class DeclaredFactDetector {
  constructor() {
    this.name = "declared-mechanical";
    this.model = "none";
    this.temperature = 0;
    this.apiVersion = "local";
    this.paperAligned = false;
  }

  async detect({ messages }) {
    return {
      annotations: messages.map((message) => ({
        message_index: message.index,
        fact_ids: message.authorized_declared_fact_ids,
      })),
      provider_meta: {
        response_id: null,
        response_model: null,
        stop_reason: "mechanical",
        usage: null,
        api_version: this.apiVersion,
      },
    };
  }
}

export class OpenAIResponsesProvider {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    endpoint =
      process.env.OPENAI_RESPONSES_ENDPOINT ||
      "https://api.openai.com/v1/responses",
    model = process.env.OPENAI_MODEL || "gpt-5-mini",
    maxOutputTokens = 600,
    temperature = 0,
    fetchImpl = fetch,
  } = {}) {
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is required for --provider openai. Dry-run mode does not require a key.",
      );
    }
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.model = model;
    this.maxOutputTokens = maxOutputTokens;
    this.temperature = /^gpt-5(?:-|$)/.test(this.model) ? null : temperature;
    this.fetchImpl = fetchImpl;
    this.name = "openai-responses";
    this.apiVersion = "v1/responses";
  }

  request(request) {
    return postJson({
      fetchImpl: this.fetchImpl,
      endpoint: this.endpoint,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      request,
      label: "OpenAI Responses API",
    });
  }

  parse(body, emptyMessage = "OpenAI response did not contain output_text.") {
    const text = responseText(body);
    if (!text) throw new Error(emptyMessage);
    return {
      ...JSON.parse(text),
      provider_meta: responseMetadata(body, this.apiVersion),
    };
  }

  async respond({
    phase,
    agent,
    transcript,
    hiddenInfoCue,
    minMessages,
    maxMessages,
  }) {
    const request = {
      model: this.model,
      max_output_tokens: this.maxOutputTokens,
      instructions: participantInstructions({
        phase,
        agent,
        hiddenInfoCue,
        minMessages,
        maxMessages,
      }),
      input: `Public transcript:\n${formatTranscript(transcript)}`,
      text: {
        format: {
          type: "json_schema",
          name: phase === "public_action" ? "participant_action" : "participant_choice",
          strict: true,
          schema: participantSchema(phase),
        },
      },
      ...(Number.isFinite(this.temperature)
        ? { temperature: this.temperature }
        : {}),
    };

    return this.parse(await this.request(request));
  }
}

export class OpenAIFactDetector extends OpenAIResponsesProvider {
  constructor(options = {}) {
    super({
      ...options,
      model: options.model || process.env.OPENAI_DETECTOR_MODEL || "gpt-4o",
      maxOutputTokens: options.maxOutputTokens || 2400,
      temperature: options.temperature ?? 0,
    });
    this.name = "openai-posthoc-fact-detector";
    this.paperAligned = this.model === "gpt-4o";
  }

  async detect({ messages, task }) {
    const request = {
      model: this.model,
      max_output_tokens: this.maxOutputTokens,
      ...(Number.isFinite(this.temperature)
        ? { temperature: this.temperature }
        : {}),
      instructions: factCodingInstructions(task),
      input: `Public transcript:\n${formatNumberedTranscript(messages)}`,
      text: {
        format: {
          type: "json_schema",
          name: "fact_annotations",
          strict: true,
          schema: factCodingSchema(),
        },
      },
    };
    return this.parse(
      await this.request(request),
      "OpenAI detector response contained no output_text.",
    );
  }
}

export class AnthropicMessagesProvider {
  constructor({
    apiKey = process.env.ANTHROPIC_API_KEY,
    endpoint =
      process.env.ANTHROPIC_MESSAGES_ENDPOINT ||
      "https://api.anthropic.com/v1/messages",
    model =
      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    maxOutputTokens = 600,
    temperature = 0,
    fetchImpl = fetch,
  } = {}) {
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is required for --provider anthropic. Dry-run mode does not require a key.",
      );
    }
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.model = model;
    this.maxOutputTokens = maxOutputTokens;
    this.temperature =
      /^claude-(?:sonnet|opus|fable)-5(?:-|$)/.test(this.model)
        ? null
        : temperature;
    this.fetchImpl = fetchImpl;
    this.name = "anthropic-messages";
    this.apiVersion = "2023-06-01";
  }

  request(request) {
    return postJson({
      fetchImpl: this.fetchImpl,
      endpoint: this.endpoint,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.apiVersion,
      },
      request,
      label: "Anthropic Messages API",
    });
  }

  parse(body, emptyMessage = "Anthropic response did not contain a text block.") {
    const text = anthropicResponseText(body);
    if (!text) throw new Error(emptyMessage);
    return {
      ...JSON.parse(text),
      provider_meta: responseMetadata(body, this.apiVersion),
    };
  }

  async respond({
    phase,
    agent,
    transcript,
    hiddenInfoCue,
    minMessages,
    maxMessages,
  }) {
    const request = {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      system: participantInstructions({
        phase,
        agent,
        hiddenInfoCue,
        minMessages,
        maxMessages,
      }),
      messages: [
        {
          role: "user",
          content: `Public transcript:\n${formatTranscript(transcript)}`,
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: withoutLengthLimits(participantSchema(phase)),
        },
      },
      ...(Number.isFinite(this.temperature)
        ? { temperature: this.temperature }
        : {}),
    };

    return this.parse(await this.request(request));
  }
}

export class AnthropicFactDetector extends AnthropicMessagesProvider {
  constructor(options = {}) {
    super({
      ...options,
      model:
        options.model ||
        process.env.ANTHROPIC_DETECTOR_MODEL ||
        "claude-sonnet-5",
      maxOutputTokens: options.maxOutputTokens || 6000,
      temperature: options.temperature ?? 0,
    });
    this.name = "anthropic-posthoc-fact-detector";
    this.paperAligned = false;
  }

  async detect({ messages, task }) {
    const request = {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      ...(Number.isFinite(this.temperature)
        ? { temperature: this.temperature }
        : {}),
      system: factCodingInstructions(task),
      messages: [
        {
          role: "user",
          content: `Public transcript:\n${formatNumberedTranscript(messages)}`,
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: withoutLengthLimits(factCodingSchema()),
        },
      },
    };
    const body = await this.request(request);
    const types = (body.content || []).map((item) => item.type).join(", ");
    return this.parse(
      body,
      `Anthropic detector response contained no text (stop_reason=${body.stop_reason || "unknown"}; content_types=${types || "none"}).`,
    );
  }
}
