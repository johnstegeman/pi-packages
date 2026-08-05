# Bifrost Responses API + Native Anthropic Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the bifrost extension from `/v1/chat/completions` to `/v1/responses` for non-Anthropic models and `/anthropic/v1/messages` for Anthropic models, preserving Anthropic prompt caching.

**Architecture:** Per-model API routing — each model gets its own `api` type string and `baseUrl`. Anthropic models (`anthropic/*`) use `"anthropic-messages"` pointing at `${gatewayUrl}/anthropic` (SDK appends `/v1/messages`). All other models use `"openai-responses"` pointing at `${gatewayUrl}/v1`. Pi-ai's `BUILTIN_APIS` registry resolves the string names to implementations. No factory imports needed.

**Tech Stack:** TypeScript, `node:test`, tsx, pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`)

## Global Constraints

- No new runtime npm dependencies — only uses existing `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` peer deps
- Tests use `node:test` with `node --import tsx --test test/*.test.ts` (matching other packages in this repo, e.g. `packages/hashline-edit`)
- `tsx` is added as a devDependency to `packages/bifrost/package.json` (matching the pattern in `packages/hashline-edit/package.json`)
- No pi-ai core changes — everything is contained within the bifrost extension
- The `isBifrostAnthropicModel()` function is unchanged — still checks `id.startsWith("anthropic/")`
- The `detectReasoning()` function is unchanged
- OAuth flow, model discovery endpoint (`/v1/models`), cost attribution headers, and session start notification are all unchanged

---

### Task 1: Add test infrastructure and failing tests for `toProviderModel`

**Files:**
- Modify: `packages/bifrost/package.json` (add `"type": "module"`, test script, tsx devDependency)
- Create: `packages/bifrost/test/to-provider-model.test.ts`

**Interfaces:**
- Consumes: `toProviderModel` from `packages/bifrost/index.ts` (will be exported in Task 2)
- Produces: test suite verifying per-model `api` and `baseUrl` selection

- [ ] **Step 1: Add test infrastructure to `packages/bifrost/package.json`**

The bifrost package currently has no scripts, `"type"` field, or `tsx` devDependency. Update `packages/bifrost/package.json` to:

```json
{
  "name": "pi-bifrost",
  "version": "0.1.0",
  "description": "Pi extension: Bifrost AI gateway provider",
  "type": "module",
  "keywords": ["pi-package"],
  "license": "MIT",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "scripts": {
    "test": "node --import tsx --test test/*.test.ts"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "0.80.3",
    "@earendil-works/pi-ai": "*",
    "@types/node": "26.1.1",
    "tsx": "4.20.6"
  }
}
```

Then install dependencies:

```bash
cd packages/bifrost && npm install
```

- [ ] **Step 2: Write the failing tests**

Create `packages/bifrost/test/to-provider-model.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/bifrost && node --import tsx --test test/to-provider-model.test.ts`
Expected: FAIL — `toProviderModel` is not exported from `index.ts`, the current signature takes only one argument (no `gatewayUrl`), and the current implementation returns `compat: { cacheControlFormat: "anthropic" }` for Anthropic models instead of `undefined`.

- [ ] **Step 4: Commit the failing test**

```bash
git add packages/bifrost/package.json packages/bifrost/test/to-provider-model.test.ts
git commit -m "test(bifrost): add failing tests for per-model API routing"
```

---

### Task 2: Update `toProviderModel` to set per-model `api` and `baseUrl`

**Files:**
- Modify: `packages/bifrost/index.ts:190-224` (the `isBifrostAnthropicModel` doc comment + `toProviderModel` function)

**Interfaces:**
- Consumes: `isBifrostAnthropicModel` (unchanged), `detectReasoning` (unchanged), `parsePrice` (unchanged), `PiModelInput` (unchanged)
- Produces: `toProviderModel(m: BifrostModel, gatewayUrl: string)` — now sets `api`, `baseUrl` per model and never sets `compat`. Exported for testing.

- [ ] **Step 1: Update the `isBifrostAnthropicModel` doc comment**

In `packages/bifrost/index.ts`, replace the doc comment above `isBifrostAnthropicModel` (lines 190–196) with:

```typescript
/**
 * Bifrost exposes Anthropic models under the `anthropic/<model>` id
 * namespace (e.g. `anthropic/claude-opus-4-6`). For these, use the native
 * Anthropic Messages API (`/anthropic/v1/messages`) with full `cache_control`
 * prompt caching support — mirroring the automatic prompt-caching behavior
 * of pi's native Anthropic provider.
 */
```

- [ ] **Step 2: Update `toProviderModel` function signature and body**

Replace the entire `toProviderModel` function (lines 201–224) with:

```typescript
export function toProviderModel(m: BifrostModel, gatewayUrl: string) {
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

Key changes:
- Added `export` keyword
- Added `gatewayUrl: string` parameter
- Added `api` field: `"anthropic-messages"` for Anthropic models, `"openai-responses"` for all others
- Added `baseUrl` field: `${gatewayUrl}/anthropic` for Anthropic models (SDK appends `/v1/messages`), `${gatewayUrl}/v1` for others (SDK appends `/responses`)
- Removed the `compat: { cacheControlFormat: "anthropic" }` conditional — `anthropic-messages` handles caching natively

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd packages/bifrost && node --import tsx --test test/to-provider-model.test.ts`
Expected: PASS — all 6 tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/bifrost/index.ts
git commit -m "feat(bifrost): per-model API routing — anthropic-messages for Anthropic, openai-responses for others"
```

---

### Task 3: Update `fetchModels` to pass `gatewayUrl` through

**Files:**
- Modify: `packages/bifrost/index.ts:226-243` (the `fetchModels` function)

**Interfaces:**
- Consumes: `toProviderModel(m, gatewayUrl)` from Task 2
- Produces: `fetchModels` now forwards `gatewayUrl` to each model

- [ ] **Step 1: Update `fetchModels` to pass `gatewayUrl` to `toProviderModel`**

In `packages/bifrost/index.ts`, the `fetchModels` function currently calls `toProviderModel` without `gatewayUrl` on line 242:

```typescript
return (body.data ?? []).map(toProviderModel);
```

Replace that line with:

```typescript
return (body.data ?? []).map((m) => toProviderModel(m, base));
```

Note: `base` is already defined on line 230 as `gatewayUrl.replace(/\/$/, "")` — it's the URL with trailing slash stripped. This ensures per-model `baseUrl` values don't have double slashes from a trailing slash on the gateway URL.

- [ ] **Step 2: Run existing tests to verify nothing broke**

Run: `cd packages/bifrost && node --import tsx --test test/to-provider-model.test.ts`
Expected: PASS — all tests still pass (fetchModels change doesn't affect toProviderModel tests, but confirms no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add packages/bifrost/index.ts
git commit -m "fix(bifrost): pass gatewayUrl through fetchModels to toProviderModel"
```

---

### Task 4: Change provider `api` from `openai-completions` to `openai-responses`

**Files:**
- Modify: `packages/bifrost/index.ts:286` (the `api` field in `register()`)

**Interfaces:**
- Consumes: pi-ai's `BUILTIN_APIS` registry (resolves `"openai-responses"` and `"anthropic-messages"` strings automatically)
- Produces: provider default `api` is now `"openai-responses"`; per-model `api` values override for Anthropic models

- [ ] **Step 1: Change the `api` field in `register()`**

In `packages/bifrost/index.ts` line 286, change:

```typescript
      api: "openai-completions",
```

to:

```typescript
      api: "openai-responses",
```

This is the provider-level default. Individual models that set `api: "anthropic-messages"` (via `toProviderModel`) will override this for Anthropic models.

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `cd packages/bifrost && node --import tsx --test test/to-provider-model.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/bifrost/index.ts
git commit -m "feat(bifrost): switch provider default api to openai-responses"
```

---

### Task 5: Update README.md

**Files:**
- Modify: `packages/bifrost/README.md`

**Interfaces:**
- N/A (documentation only)

- [ ] **Step 1: Add API routing section to README**

The README doesn't currently mention the API type or caching behavior. Add a new section after the "Model metadata" section (after the line `Bifrost pricing values are per-token USD strings; pi expects per-million-token USD numbers, so each value is multiplied by 1 000 000.`) and before "Cost attribution":

```markdown
## API routing

Bifrost supports two request protocols, and the extension routes each model
to the most appropriate one:

- **Anthropic models** (`anthropic/*`) use the native Anthropic Messages API
  (`/anthropic/v1/messages`) with full prompt caching via `cache_control`
  markers — the same caching behavior as pi's built-in Anthropic provider.
- **All other models** use the OpenAI Responses API (`/v1/responses`) with
  `prompt_cache_key`-based caching.

This routing is automatic and based on the model ID prefix. No configuration
is needed.
```

- [ ] **Step 2: Commit**

```bash
git add packages/bifrost/README.md
git commit -m "docs(bifrost): document API routing — Anthropic native vs OpenAI Responses"
```

---

### Task 6: Manual verification

**Files:**
- N/A (runtime verification only)

- [ ] **Step 1: Verify the extension loads without errors**

Run pi with the bifrost extension loaded and confirm no errors at startup:

```bash
pi -e /path/to/pi-packages/packages/bifrost
```

Expected: no errors in console, model list populates from the gateway.

- [ ] **Step 2: Verify Anthropic model routes to `/anthropic/v1/messages`**

In a pi session with the bifrost extension, select an Anthropic model (e.g. `anthropic/claude-sonnet-4-6`) and send a message. Confirm the request succeeds and response is received.

- [ ] **Step 3: Verify non-Anthropic model routes to `/v1/responses`**

In the same session, switch to a non-Anthropic model (e.g. `fireworks/glm-5p2`) and send a message. Confirm the request succeeds and response is received.

- [ ] **Step 4: Verify Anthropic prompt caching is active**

Check the Bifrost gateway logs or usage stats to confirm that Anthropic model requests show `cache_read_input_tokens` > 0 on subsequent requests with the same system prompt.

No commit needed for this task — it's verification only.
