# pi-bifrost

Pi extension that registers [Bifrost](https://docs.getbifrost.ai) as a model
provider. Models are discovered dynamically from the gateway at startup, so any
model your virtual key has access to appears in `/model` automatically.

## Setup

You have two options. Environment variables take priority over the stored login.

### Option A — environment variables

```bash
export BIFROST_GATEWAY_URL=https://your-gateway.example.com
export BIFROST_VIRTUAL_KEY=sk-bf-...
```

Add these to your shell profile (`.zshrc`, `.bashrc`, etc.) for persistence.

### Option B — interactive login

```
/login bifrost
```

Pi will prompt for your gateway URL and virtual key, then store them in
`~/.pi/agent/bifrost-config.json`. Models are re-fetched immediately after
login — no restart required.

You can mix the two: for example, set `BIFROST_GATEWAY_URL` via env var and
let `/login bifrost` handle the virtual key (the env var wins for whichever
field is set).

## Usage

After setup, use `/model` (or `Ctrl+P`) to browse and select any model the
gateway exposes. Models are prefixed `bifrost/` in the model list.

## Installation

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/pi-packages/packages/bifrost"
  ]
}
```

Or load for a single session:

```bash
pi -e /path/to/pi-packages/packages/bifrost
```

## Model metadata

The following fields are mapped from the Bifrost `/v1/models` response:

| Pi field | Bifrost field |
|---|---|
| `id` | `id` |
| `name` | `name` |
| `contextWindow` | `context_length` (falls back to `128 000`; for Fireworks `accounts/.../models/...` ids that omit it — DeepSeek V3+/R1 and Kimi K3 where the gateway reports none — mirrors pi's catalog: `1 000 000` for DeepSeek/Kimi K3, `262 144` for Kimi K2.x) |
| `maxTokens` | `max_output_tokens` (falls back to `top_provider.max_completion_tokens`; when neither is reported, `32 768` for reasoning models so thinking + text fit the output budget, otherwise `4 096`) |
| `input` | `architecture.input_modalities` (detects image support) |
| `cost.input` | `pricing.prompt` × 1 000 000 |
| `cost.output` | `pricing.completion` × 1 000 000 |
| `cost.cacheRead` | `pricing.input_cache_read` × 1 000 000 |
| `cost.cacheWrite` | `pricing.input_cache_write` × 1 000 000 |
| `reasoning` | non-zero `pricing.internal_reasoning`, or model-family name patterns (OpenAI o1/o3/o4/gpt-5, Claude 4.x+/3.7, Gemini 2.5+/3.x, GLM, Kimi K2.5+, DeepSeek V3+/R1, MiniMax M2+, Grok 3+, Qwen3.5+, Magistral, etc. — excluding audio/image/embedding/moderation/frozen-chat-latest variants) |

Bifrost pricing values are per-token USD strings; pi expects per-million-token
USD numbers, so each value is multiplied by 1 000 000.

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

## Cost attribution

Every request to the Bifrost gateway includes an `x-pi-session` header set to
the current workspace directory basename (e.g. the worktree name, `pi-packages`),
so Bifrost can attribute token usage and cost to the pi session that produced it.
The value is resolved live at request time from pi's current working directory,
so it always reflects the active workspace.

When a Superpowers workflow phase is active (emitted on the `superpowers:phase`
event bus), Bifrost requests also carry an `x-superpowers-phase` header set to the
current phase (e.g. `brainstorming`, `development`) for phase-based cost
attribution. The header is omitted when no phase is active or the phase has been
cleared (empty/null).