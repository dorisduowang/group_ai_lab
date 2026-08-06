import { CITIES } from "./config.js";
import { DeclaredFactDetector } from "./provider.js";

export const DEFAULT_SEED = 100;

export function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [output[index], output[swapWith]] = [output[swapWith], output[index]];
  }
  return output;
}

function gini(values) {
  const adjusted = values.map((value) => value + 1e-7).sort((a, b) => a - b);
  const n = adjusted.length;
  const numerator = adjusted.reduce(
    (sum, value, index) => sum + (2 * (index + 1) - n - 1) * value,
    0,
  );
  const denominator = n * adjusted.reduce((sum, value) => sum + value, 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

function majorityChoice(choices) {
  const counts = Object.fromEntries(CITIES.map((city) => [city, 0]));
  for (const choice of choices) counts[choice] += 1;
  return CITIES.reduce((best, city) =>
    counts[city] > counts[best] ? city : best,
  );
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(String))];
}

function normalizeAction(rawAction, agent, task) {
  const action = rawAction.action || "speak";
  if (!["speak", "wait", "finish"].includes(action)) {
    throw new Error(`${agent.name} returned an invalid action: ${action}.`);
  }

  const message = String(rawAction.message || "").trim();
  if (action === "speak" && !message) {
    throw new Error(`${agent.name} chose speak but returned an empty message.`);
  }
  if (message.length > 1200) {
    throw new Error(
      `${agent.name} returned a public message over 1200 characters.`,
    );
  }

  const declaredFactIds = uniqueStrings(rawAction.shared_fact_ids);
  const validCatalogIds = new Set(task.facts.map((fact) => fact.id));
  const allowed = new Set(agent.profile.allowedFactIds);
  const authorizedDeclaredFactIds = declaredFactIds.filter(
    (id) => validCatalogIds.has(id) && allowed.has(id),
  );
  const unauthorizedDeclaredFactIds = declaredFactIds.filter(
    (id) => !validCatalogIds.has(id) || !allowed.has(id),
  );

  return {
    action,
    message,
    declaredFactIds,
    authorizedDeclaredFactIds,
    unauthorizedDeclaredFactIds,
    providerMeta: rawAction.provider_meta || null,
  };
}

function decisionEntry(agent, result, cycle, index) {
  return {
    decision_index: index,
    cycle,
    agent_id: agent.id,
    agent_name: agent.name,
    action: result.action,
    proposed_message: result.message,
    declared_fact_ids: result.declaredFactIds,
    authorized_declared_fact_ids: result.authorizedDeclaredFactIds,
    unauthorized_declared_fact_ids: result.unauthorizedDeclaredFactIds,
    provider_meta: result.providerMeta,
    published_message_index: null,
  };
}

function publishMessage(messages, agent, result, cycle, logEntry) {
  const message = {
    index: messages.length,
    cycle,
    sender_id: agent.id,
    sender_name: agent.name,
    text: result.message,
    declared_fact_ids: result.declaredFactIds,
    authorized_declared_fact_ids: result.authorizedDeclaredFactIds,
    unauthorized_declared_fact_ids: result.unauthorizedDeclaredFactIds,
    provider_meta: result.providerMeta,
  };
  messages.push(message);
  logEntry.published_message_index = message.index;
}

function normalizeDetection(rawDetection, messages, task) {
  const validCatalogIds = new Set(task.facts.map((fact) => fact.id));
  const byIndex = new Map();
  const duplicateMessageIndexes = [];

  for (const annotation of rawDetection.annotations || []) {
    const index = Number(annotation.message_index);
    if (byIndex.has(index)) duplicateMessageIndexes.push(index);
    byIndex.set(index, uniqueStrings(annotation.fact_ids));
  }

  const missingMessageIndexes = [];
  const unknownFactIds = [];
  const annotatedMessages = messages.map((message) => {
    if (!byIndex.has(message.index)) missingMessageIndexes.push(message.index);
    const rawDetectedFactIds = byIndex.get(message.index) || [];
    const detectedFactIds = rawDetectedFactIds.filter((id) =>
      validCatalogIds.has(id),
    );
    const invalidDetectedFactIds = rawDetectedFactIds.filter(
      (id) => !validCatalogIds.has(id),
    );
    unknownFactIds.push(...invalidDetectedFactIds);
    return {
      ...message,
      raw_detected_fact_ids: rawDetectedFactIds,
      detected_fact_ids: detectedFactIds,
      invalid_detected_fact_ids: invalidDetectedFactIds,
      shared_fact_ids: detectedFactIds,
    };
  });

  return {
    messages: annotatedMessages,
    audit: {
      detector_provider_meta: rawDetection.provider_meta || null,
      raw_annotations: rawDetection.annotations || [],
      missing_message_indexes: missingMessageIndexes,
      duplicate_message_indexes: [...new Set(duplicateMessageIndexes)],
      unknown_fact_ids: [...new Set(unknownFactIds)],
    },
  };
}

function collectFirstMentions(messages) {
  const firstMentions = new Map();
  for (const message of messages) {
    for (const factId of message.detected_fact_ids) {
      if (!firstMentions.has(factId)) {
        firstMentions.set(factId, {
          fact_id: factId,
          message_index: message.index,
          sender_id: message.sender_id,
          sender_name: message.sender_name,
        });
      }
    }
  }
  return firstMentions;
}

function firstMentionAudit(messages, agents) {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const firstMentions = collectFirstMentions(messages);
  const sourceViolations = [...firstMentions.values()].filter((mention) => {
    const agent = agentsById.get(mention.sender_id);
    return !agent?.profile.allowedFactIds.includes(mention.fact_id);
  });
  return {
    first_mentions: [...firstMentions.values()],
    source_violations: sourceViolations,
  };
}

export function computeMetrics(
  messages,
  finalChoices,
  factsById,
  participantIds = [],
) {
  const mentions = collectFirstMentions(messages);

  const uniqueFacts = [...mentions.keys()];
  const cityCoverage = Object.fromEntries(CITIES.map((city) => [city, 0]));
  uniqueFacts.forEach((id) => {
    const fact = factsById.get(id);
    if (fact) cityCoverage[fact.city] += 1;
  });

  const ids =
    participantIds.length > 0
      ? participantIds
      : [...new Set(messages.map((message) => message.sender_id))];
  const contributionCounts = Object.fromEntries(ids.map((id) => [id, 0]));
  mentions.forEach((mention) => {
    const senderId = mention.sender_id;
    contributionCounts[senderId] = (contributionCounts[senderId] || 0) + 1;
  });
  const contributions = Object.values(contributionCounts);
  const choices = finalChoices.map((entry) => entry.choice);
  const groupChoice = majorityChoice(choices);

  return {
    group_selection: groupChoice,
    chose_eldoron: groupChoice === "Eldoron",
    unanimous: new Set(choices).size === 1,
    n_messages_no_facilitator: messages.length,
    n_total_facts_mentioned: uniqueFacts.length,
    fact_density:
      messages.length === 0 ? 0 : uniqueFacts.length / messages.length,
    n_eldoron_facts: cityCoverage.Eldoron,
    n_myloria_facts: cityCoverage.Myloria,
    n_cragnio_facts: cityCoverage.Cragnio,
    options_gini_coef: gini(Object.values(cityCoverage)),
    fact_sharing_min: contributions.length ? Math.min(...contributions) : 0,
    fact_sharing_max: contributions.length ? Math.max(...contributions) : 0,
    all_members_contributed_fact:
      contributions.length > 0 && contributions.every((value) => value > 0),
  };
}

async function autonomousDiscussion({
  agents,
  provider,
  task,
  random,
  hiddenInfoCue,
  minMessages,
  maxMessages,
  maxCycles,
}) {
  const messages = [];
  const decisionLog = [];
  const finished = new Set();
  let terminationReason = "max_cycles";
  let cyclesCompleted = 0;

  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const activeAgents = agents.filter((agent) => !finished.has(agent.id));
    if (activeAgents.length === 0) {
      terminationReason = "all_agents_finished";
      break;
    }

    const snapshot = structuredClone(messages);
    const decisions = await Promise.all(
      activeAgents.map(async (agent) => ({
        agent,
        decision: normalizeAction(
          await provider.respond({
            phase: "public_action",
            agent,
            transcript: snapshot,
            turnIndex: cycle,
            hiddenInfoCue,
            minMessages,
            maxMessages,
          }),
          agent,
          task,
        ),
      })),
    );
    cyclesCompleted = cycle + 1;

    const loggedDecisions = decisions.map(({ agent, decision }) => {
      if (decision.action === "finish") finished.add(agent.id);
      const entry = decisionEntry(agent, decision, cycle, decisionLog.length);
      decisionLog.push(entry);
      return { agent, decision, entry };
    });

    const speakers = shuffle(
      loggedDecisions.filter(({ decision }) => decision.action === "speak"),
      random,
    );
    for (const { agent, decision, entry } of speakers) {
      if (messages.length >= maxMessages) break;
      publishMessage(messages, agent, decision, cycle, entry);
    }

    if (messages.length >= maxMessages) {
      terminationReason = "max_messages";
      break;
    }
    if (finished.size === agents.length) {
      terminationReason = "all_agents_finished";
      break;
    }
  }

  return {
    messages,
    decisionLog,
    cyclesCompleted,
    terminationReason,
  };
}

function collectChoices(phase, agents, provider, transcript, context) {
  return Promise.all(
    agents.map(async (agent) => ({
      agent_id: agent.id,
      agent_name: agent.name,
      ...(await provider.respond({
        phase,
        agent,
        transcript,
        ...context,
      })),
    })),
  );
}

export async function runSimulation({
  task,
  personas,
  provider,
  factDetector = new DeclaredFactDetector(),
  seed = DEFAULT_SEED,
  maxMessages = 15,
  minMessages = 5,
  maxCycles = 10,
  hiddenInfoCue = false,
  runId = `agent-${seed}`,
  reproducibility = {},
}) {
  const random = seededRandom(seed);
  const assignments = shuffle(task.profiles, random);
  const agents = assignments.map((profile, index) => ({
    index,
    id: `agent-${index + 1}`,
    name: profile.name,
    profile,
    persona: personas[index],
  }));

  const choiceContext = { hiddenInfoCue, minMessages, maxMessages };
  const preChoices = await collectChoices(
    "pre_choice",
    agents,
    provider,
    [],
    choiceContext,
  );

  const discussion = await autonomousDiscussion({
    agents,
    provider,
    task,
    random,
    hiddenInfoCue,
    minMessages,
    maxMessages,
    maxCycles,
  });

  const rawDetection = await factDetector.detect({
    messages: discussion.messages,
    task,
  });
  const detection = normalizeDetection(rawDetection, discussion.messages, task);
  const messages = detection.messages;

  const finalChoices = await collectChoices(
    "final_choice",
    agents,
    provider,
    messages,
    choiceContext,
  );

  const metrics = computeMetrics(
    messages,
    finalChoices,
    task.factsById,
    agents.map((agent) => agent.id),
  );
  const mentionAudit = firstMentionAudit(messages, agents);
  const unauthorizedDeclarations = discussion.decisionLog.filter(
    (entry) => entry.unauthorized_declared_fact_ids.length > 0,
  );
  const speakers = new Set(messages.map((message) => message.sender_id));

  return {
    schema_version: "2.0",
    run_id: runId,
    seed,
    reproducibility,
    protocol: {
      task: "GRAIL hidden-profile host-city decision",
      participant_count: agents.length,
      interaction: "autonomous",
      min_messages: minMessages,
      max_messages: maxMessages,
      max_cycles: maxCycles,
      cycles_completed: discussion.cyclesCompleted,
      termination_reason: discussion.terminationReason,
      hidden_info_cue: hiddenInfoCue,
      facilitator: false,
      provider: provider.name,
      model: provider.model,
      temperature: provider.temperature ?? null,
      max_output_tokens: provider.maxOutputTokens ?? null,
      provider_api_version: provider.apiVersion || null,
      fact_detector: factDetector.name,
      fact_detector_model: factDetector.model,
      fact_detector_temperature: factDetector.temperature ?? null,
      fact_detector_max_output_tokens:
        factDetector.maxOutputTokens ?? null,
      fact_detector_api_version: factDetector.apiVersion || null,
      fact_detector_paper_aligned: Boolean(factDetector.paperAligned),
    },
    agents: agents.map((agent) => ({
      id: agent.id,
      display_name: agent.name,
      private_profile: agent.profile.name,
      private_fact_ids: agent.profile.allowedFactIds,
      persona_source: agent.persona.source,
      persona_name: agent.persona.sourceName || agent.persona.id,
      persona_participant_id: agent.persona.participantId,
    })),
    pre_deliberation_choices: preChoices,
    decision_log: discussion.decisionLog,
    messages,
    final_choices: finalChoices,
    fact_detection_audit: {
      ...detection.audit,
      ...mentionAudit,
      unauthorized_declarations: unauthorizedDeclarations,
    },
    quality_checks: {
      minimum_message_target_met: messages.length >= minMessages,
      all_five_agents_spoke: speakers.size === agents.length,
      no_unknown_detected_fact_ids:
        detection.audit.unknown_fact_ids.length === 0,
      detector_annotated_every_message:
        detection.audit.missing_message_indexes.length === 0,
      no_first_mention_source_violations:
        mentionAudit.source_violations.length === 0,
    },
    metrics,
  };
}
