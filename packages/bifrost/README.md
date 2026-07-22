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
| `contextWindow` | `context_length` |
| `maxTokens` | `max_output_tokens` (falls back to `top_provider.max_completion_tokens`) |
| `input` | `architecture.input_modalities` (detects image support) |
| `cost.input` | `pricing.prompt` × 1 000 000 |
| `cost.output` | `pricing.completion` × 1 000 000 |
| `cost.cacheRead` | `pricing.input_cache_read` × 1 000 000 |
| `cost.cacheWrite` | `pricing.input_cache_write` × 1 000 000 |
| `reasoning` | non-zero `pricing.internal_reasoning`, or name patterns (`o1`, `o3`, `r1`, `thinking`, `reasoner`) |

Bifrost pricing values are per-token USD strings; pi expects per-million-token
USD numbers, so each value is multiplied by 1 000 000.
