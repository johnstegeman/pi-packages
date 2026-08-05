# Bifrost Extension: Switch to /v1/responses + Native Anthropic Passthrough

**Date:** 2026-08-05  
**Status:** Approved  
**Scope:** `packages/bifrost/index.ts` and `packages/bifrost/README.md`

## Problem

The bifrost extension currently registers all models with `api: "openai-completions"`, routing every request through `/v1/chat/completions`. This works but uses the older, less capable Chat Completions protocol. OpenAI's newer Responses API (`/v1/responses`) offers richer features (encrypted reasoning, reasoning summaries, service tiers, event-based streaming, structured message types).

Testing revealed that switching all models to `/v1/responses` would break Anthropic prompt caching — Bifrost's `/v1/responses` endpoint returns `input_tokens_details: null` for Anthropic models, meaning no caching occurs. However, Bifrost's native Anthropic passthrough (`/anthropic/v1/messages`) does support `cache_control` markers and returns proper `cache_read_input_tokens` / `cache_creation_input_tokens` fields.

## Solution

Use **per-model API routing** based on the model's backend:

- **`anthropic/*` models** → `api: "anthropic-messages"`, `baseUrl: ${gatewayUrl}/anthropic`  
  Routes through Bifrost's native Anthropic passthrough (`/anthropic/v1/messages`). Full `cache_control` prompt caching support. The Anthropic SDK appends `/v1/messages` to the base URL automatically.

- **All other models** → `api: "openai-responses"`, `baseUrl: ${gatewayUrl}/v1`  
  Routes through Bifrost's `/v1/responses` endpoint. Uses `prompt_cache_key` for caching (confirmed working for non-Anthropic backends like Fireworks/GLM).

Pi supports per-model `api` fields — each model in the `models` array can specify its own `api` type string, and pi-ai's built-in `BUILTIN_APIS` registry resolves the string to the correct implementation. No object map or factory imports are needed.

## Test Evidence

| Endpoint | Model | Caching? | Cache Token Reporting |
|---|---|---|---|
| `/v1/chat/completions` + `cache_control` | anthropic/claude-sonnet-4-6 | ✅ 1675 tokens | ✅ `cached_tokens` |
| `/v1/responses` + `prompt_cache_key` | anthropic/claude-sonnet-4-6 | ❌ No | ❌ `input_tokens_details: null` |
| `/v1/responses` + `prompt_cache_key` | fireworks/glm-5p2 | ✅ 1580 tokens | ✅ `cached_tokens` |
| `/anthropic/v1/messages` + `cache_control` | anthropic/claude-sonnet-4-6 | ✅ 1675 tokens | ✅ `cache_read_input_tokens` |

Bifrost accepts both prefixed (`anthropic/claude-sonnet-4-6`) and unprefixed (`claude-sonnet-4-6`) model IDs on the `/anthropic/v1/messages` endpoint. Bifrost also accepts `Authorization: Bearer <key>` on both `/v1/responses` and `/anthropic/v1/messages`.

## Changes

### 1. `toProviderModel` function

Pi-ai has a built-in `BUILTIN_APIS` registry that maps string API names (like `"anthropic-messages"` and `"openai-responses"`) to their implementations automatically. No factory function imports are required — the extension just uses string values for the `api` field, and pi-ai resolves them through the registry.

Add a `gatewayUrl` parameter. Set per-model `api` and `baseUrl` based on whether the model is an Anthropic model. Remove the `compat: { cacheControlFormat: "anthropic" }` conditional — `anthropic-messages` handles caching natively.

```typescript
function toProviderModel(m: BifrostModel, gatewayUrl: string) {
  const inputModalities = m.architecture?.input_modalities ?? [];
  const input: PiModelInput = inputModalities.includes("image")
    ? ["text", "image"]
    : ["text"];

  const isAnthropic = isBifrostAnthropicModel(m.id);

  return {
    id: m.id,
    name: m.name ?? m.id,
    api: isAnthropic ? "anthropic-messages" : "openai-responses",
    baseUrl: isAnthropic
      ? `${gatewayUrl}/anthropic`
      : `${gatewayUrl}/v1`,
    reasoning: detectReasoning(m),
    input,
    cost: {
      input: parsePrice(m.pricing?.prompt),
      output: parsePrice(m.pricing?.completion),
      cacheRead: parsePrice(m.pricing?.input_cache_read),
      cacheWrite: parsePrice(m.pricing?.input_cache_write),
    },
    contextWindow: m.context_length ?? 128_000,
    maxTokens: m.max_output_tokens ?? m.top_provider?.max_completion_tokens ?? 4_096,
  };
}
```

The `isBifrostAnthropicModel()` function itself is unchanged — it still checks `id.startsWith("anthropic/")`.

### 2. `fetchModels` function

Pass `gatewayUrl` through to `toProviderModel`:

```typescript
async function fetchModels(
  gatewayUrl: string,
  virtualKey?: string,
): Promise<ReturnType<typeof toProviderModel>[]> {
  // ... existing fetch logic ...
  return (body.data ?? []).map((m) => toProviderModel(m, gatewayUrl));
}
```

### 3. Provider registration in `register()`

Change the provider-level `api` from `"openai-completions"` to `"openai-responses"` (the default for non-Anthropic models). Per-model `api` values on Anthropic models override this to `"anthropic-messages"`.

```typescript
// Before
api: "openai-completions",

// After
api: "openai-responses",
```

No object map is needed — the `ProviderConfigInput.api` field is typed as `Api` (a string), and pi-ai's `BUILTIN_APIS` registry resolves string names to implementations. Per-model `api` fields take precedence over the provider-level default.

The provider-level `baseUrl` remains `${currentUrl}/v1` — it serves as a fallback default, though all models now carry their own `baseUrl`.

The `authHeader: true` flag remains unchanged — it sends `Authorization: Bearer <key>`, which Bifrost accepts on both endpoints.

### 4. README.md

Update the "Model metadata" section and add a note about API routing:
- Anthropic models (`anthropic/*`) use the native Anthropic Messages API (`/anthropic/v1/messages`) with full prompt caching via `cache_control`.
- All other models use the OpenAI Responses API (`/v1/responses`) with `prompt_cache_key`-based caching.

## What doesn't change

- **OAuth flow** — login, token refresh, and config persistence are unchanged.
- **Model discovery** — still fetches from `/v1/models` and maps the response.
- **`detectReasoning()`** — reasoning detection logic is unchanged. Anthropic models with reasoning support will use Anthropic's native extended thinking format through the passthrough.
- **Cost attribution headers** — `x-pi-session` header injection via `before_provider_headers` event is unchanged.
- **Session start notification** — unchanged.
- **`isBifrostAnthropicModel()`** — unchanged, still checks `id.startsWith("anthropic/")`.

## Risk and mitigation

| Risk | Mitigation |
|---|---|
| Anthropic SDK doesn't work correctly with Bifrost's passthrough for streaming/tool calls | Confirmed endpoint accepts requests and returns proper Anthropic-format responses. Streaming and tool calls use standard Anthropic SDK behavior — Bifrost passthrough should forward transparently. The `anthropic-messages` implementation is resolved via pi-ai's `BUILTIN_APIS` registry, same as the built-in Anthropic provider. |
| Non-Anthropic model fails on `/v1/responses` | User confirmed all their Bifrost backends work with `/v1/responses`. |
| `anthropic/` prefix not accepted on native endpoint | Tested — Bifrost accepts both prefixed and unprefixed IDs. |
| Auth header incompatibility | Tested — Bifrost accepts `Authorization: Bearer` on both endpoints. |
