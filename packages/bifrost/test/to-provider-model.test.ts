import assert from "node:assert/strict";
import test from "node:test";
import { toProviderModel } from "../index.ts";

const GATEWAY = "https://gateway.example.com";

const baseModel = {
  id: "fireworks/glm-5p2",
  name: "GLM 5p2",
  context_length: 128000,
  max_output_tokens: 4096,
  architecture: { input_modalities: ["text"] },
  pricing: {
    prompt: "0.000001",
    completion: "0.000002",
    input_cache_read: "0.0000005",
    input_cache_write: "0.000001",
  },
  top_provider: { max_completion_tokens: 4096 },
};

test("non-Anthropic model gets openai-responses api and /v1 baseUrl", () => {
  const result = toProviderModel(baseModel, GATEWAY);
  assert.equal(result.api, "openai-responses");
  assert.equal(result.baseUrl, "https://gateway.example.com/v1");
});

test("Anthropic model gets anthropic-messages api and /anthropic baseUrl", () => {
  const anthropicModel = {
    ...baseModel,
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
  };
  const result = toProviderModel(anthropicModel, GATEWAY);
  assert.equal(result.api, "anthropic-messages");
  assert.equal(result.baseUrl, "https://gateway.example.com/anthropic");
});

test("Anthropic model does not get cacheControlFormat compat flag", () => {
  const anthropicModel = {
    ...baseModel,
    id: "anthropic/claude-opus-4-6",
  };
  const result = toProviderModel(anthropicModel, GATEWAY);
  assert.equal(result.compat, undefined);
});

test("non-Anthropic model does not get compat flag", () => {
  const result = toProviderModel(baseModel, GATEWAY);
  assert.equal(result.compat, undefined);
});

test("image input modality is detected", () => {
  const visionModel = {
    ...baseModel,
    architecture: { input_modalities: ["text", "image"] },
  };
  const result = toProviderModel(visionModel, GATEWAY);
  assert.deepEqual(result.input, ["text", "image"]);
});

test("cost fields are parsed from per-token to per-million-token USD", () => {
  const result = toProviderModel(baseModel, GATEWAY);
  assert.equal(result.cost.input, 1); // 0.000001 * 1_000_000
  assert.equal(result.cost.output, 2);
  assert.equal(result.cost.cacheRead, 0.5);
  assert.equal(result.cost.cacheWrite, 1);
});
