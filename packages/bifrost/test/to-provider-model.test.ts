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


test("reasoning model with no output-token metadata gets a generous maxTokens default", () => {
  // Real-world case: Bifrost serves this DeepSeek model WITHOUT
  // max_output_tokens / top_provider.max_completion_tokens, so the old
  // fallback (4096) made thinking burn the whole output budget →
  // "run hit the output token limit before producing any text".
  const deepseek = {
    id: "fireworks/accounts/fireworks/models/deepseek-v4-flash-0731",
    name: "Deepseek V4 Flash 0731",
  };
  const result = toProviderModel(deepseek, GATEWAY);
  assert.equal(result.reasoning, true);
  assert.ok(result.maxTokens >= 32768, `expected generous maxTokens, got ${result.maxTokens}`);
});

test("non-reasoning model with no output-token metadata keeps the small fallback", () => {
  const nonReasoning = {
    id: "openai/davinci-002",
    name: "Davinci 002",
  };
  const result = toProviderModel(nonReasoning, GATEWAY);
  assert.equal(result.reasoning, false);
  assert.equal(result.maxTokens, 4096);
});

test("contextWindow falls back to 1M for DeepSeek models missing context_length", () => {
  // Bifrost omits context_length for Fireworks `accounts/.../models/...`
  // ids; pi's own catalog lists the DeepSeek V4 family at 1M context. The
  // old blanket 128k fallback understated it, forcing aggressive
  // compaction and shrinking output budget in large sessions.
  const deepseek = {
    id: "fireworks/accounts/fireworks/models/deepseek-v4-flash-0731",
    name: "Deepseek V4 Flash 0731",
  };
  const result = toProviderModel(deepseek, GATEWAY);
  assert.ok(result.contextWindow >= 1_000_000, `expected >=1M, got ${result.contextWindow}`);
});

test("contextWindow falls back to 1M for Kimi K3 models missing context_length", () => {
  const kimi = {
    id: "fireworks/accounts/fireworks/models/kimi-k3",
    name: "Kimi K3",
  };
  const result = toProviderModel(kimi, GATEWAY);
  assert.ok(result.contextWindow >= 1_000_000, `expected >=1M, got ${result.contextWindow}`);
});

test("contextWindow uses the gateway-reported value when present", () => {
  // baseModel carries context_length: 128000, so the fallback must not
  // override a reported value.
  const result = toProviderModel(baseModel, GATEWAY);
  assert.equal(result.contextWindow, 128_000);
});

test("contextWindow keeps the conservative default for non-chat models", () => {
  const legacy = { id: "openai/davinci-002", name: "Davinci 002" };
  const result = toProviderModel(legacy, GATEWAY);
  assert.equal(result.contextWindow, 128_000);
});