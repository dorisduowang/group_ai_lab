import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicFactDetector,
  AnthropicMessagesProvider,
  OpenAIFactDetector,
  OpenAIResponsesProvider,
} from "../src/provider.js";

test("Responses API provider parses strict structured output", async () => {
  let captured;
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return {
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      action: "speak",
                      message: "Eldoron has welcoming residents.",
                      shared_fact_ids: ["E7"],
                    }),
                  },
                ],
              },
            ],
          };
        },
      };
    },
  });

  const result = await provider.respond({
    phase: "public_action",
    agent: {
      name: "Green",
      persona: { prompt: "Be concise." },
      profile: {
        facts: [
          {
            id: "E7",
            city: "Eldoron",
            text: "Friendly and welcoming residents",
          },
        ],
      },
    },
    transcript: [],
    hiddenInfoCue: false,
  });

  assert.deepEqual(result.shared_fact_ids, ["E7"]);
  assert.equal(result.action, "speak");
  assert.equal(captured.model, "test-model");
  assert.equal(captured.text.format.type, "json_schema");
  assert.equal(captured.text.format.strict, true);
  assert.match(captured.instructions, /historical survey material/);
  assert.match(captured.instructions, /Be concise\./);
  assert.deepEqual(
    captured.text.format.schema.properties.action.enum,
    ["speak", "wait", "finish"],
  );
});

test("Messages API provider parses schema-constrained output", async () => {
  let captured;
  let capturedHeaders;
  const provider = new AnthropicMessagesProvider({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      capturedHeaders = init.headers;
      return {
        ok: true,
        async json() {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  choice: "Eldoron",
                  rationale: "The public evidence favors Eldoron.",
                }),
              },
            ],
          };
        },
      };
    },
  });

  const result = await provider.respond({
    phase: "final_choice",
    agent: {
      name: "Green",
      persona: { prompt: "Be concise." },
      profile: {
        facts: [
          {
            id: "E7",
            city: "Eldoron",
            text: "Friendly and welcoming residents",
          },
        ],
      },
    },
    transcript: [],
    hiddenInfoCue: false,
  });

  assert.equal(result.choice, "Eldoron");
  assert.equal(captured.model, "test-model");
  assert.equal(captured.output_config.format.type, "json_schema");
  assert.equal(
    captured.output_config.format.schema.properties.rationale.maxLength,
    undefined,
  );
  assert.equal(capturedHeaders["anthropic-version"], "2023-06-01");
});

const detectorFixture = {
  facts: [
    {
      id: "E7",
      city: "Eldoron",
      text: "Friendly and welcoming residents",
    },
  ],
};

test("OpenAI post-hoc detector annotates numbered messages independently", async () => {
  let captured;
  const detector = new OpenAIFactDetector({
    apiKey: "test-key",
    model: "gpt-4o",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return {
            id: "resp-test",
            model: "gpt-4o",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      annotations: [{ message_index: 0, fact_ids: ["E7"] }],
                    }),
                  },
                ],
              },
            ],
          };
        },
      };
    },
  });
  const result = await detector.detect({
    task: detectorFixture,
    messages: [
      {
        index: 0,
        sender_name: "Green",
        text: "Residents are friendly and welcoming.",
      },
    ],
  });

  assert.deepEqual(result.annotations[0].fact_ids, ["E7"]);
  assert.equal(result.provider_meta.response_id, "resp-test");
  assert.match(captured.instructions, /Do not infer a fact merely from a declared ID/);
  assert.equal(captured.temperature, 0);
});

test("Anthropic post-hoc detector keeps response metadata", async () => {
  const detector = new AnthropicFactDetector({
    apiKey: "test-key",
    model: "test-detector",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          id: "msg-test",
          model: "test-detector",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            {
              type: "text",
              text: JSON.stringify({
                annotations: [{ message_index: 0, fact_ids: [] }],
              }),
            },
          ],
        };
      },
    }),
  });
  const result = await detector.detect({
    task: detectorFixture,
    messages: [{ index: 0, sender_name: "Green", text: "I prefer Eldoron." }],
  });

  assert.deepEqual(result.annotations[0].fact_ids, []);
  assert.equal(result.provider_meta.response_id, "msg-test");
  assert.equal(result.provider_meta.usage.input_tokens, 10);
});
