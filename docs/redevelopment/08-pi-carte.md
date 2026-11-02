# 08 — pi-carte: feature inventory (bifrost + langfuse)

Source: `packages/bifrost/` (pi-bifrost v0.1.0) and `packages/langfuse/`
(pi-langfuse-plus v0.1.0, vendored from `gooyoung/pi-langfuse` @ `c79c527`,
v1.5.12, extended with Superpowers phase metadata). Destination repo:
**pi-carte** — https://github.com/johnstegeman/pi-carte. Port posture:
**as-is**; the only redesign surface is the packaging/CI split (single repo,
plain CI — see 00 §Per-repo notes).

## 0. Repo-level facts

1. Root manifest registers `./packages/bifrost/index.ts` and
   `./packages/langfuse/index.ts`.
2. **Root `dependencies` mirror langfuse's 7 runtime deps** (pi loads
   extensions from the repo root): `@langfuse/client|otel|tracing@^5.3.0`,
   `@opentelemetry/api@^1.9.0`, `context-async-hooks@^2.7.1`,
   `sdk-node@^0.218.0`, `sdk-trace-base@^2.0.1`. Bifrost has **no runtime
   deps**. The mirroring is enforced by langfuse's own
   `test/package-manifest.test.ts` (the dep-mirror gate only covers
   pi-subagents) — **keep the test in pi-carte**.
3. Live config (this machine): `~/.pi/agent/bifrost-config.json` (0600,
   `{gatewayUrl, virtualKey}`), `~/.pi/agent/pi-langfuse/config.json`
   (0700 dir / 0600 file), and **bifrost becomes defaultProvider purely via
   `~/.pi/agent/settings.json`** (`"defaultProvider": "bifrost"`, raw gateway
   model id) — nothing in the extension does it.

## 1. bifrost — provider for a Bifrost AI gateway

Single-file extension (`index.ts`, ~460 lines). Registers a pi provider named
**`"bifrost"`**; models discovered at startup from `GET /v1/models`.

### Extension points (exact)

- `pi.registerProvider("bifrost", …)` / `pi.unregisterProvider("bifrost")`
  (re-register after login).
- `pi.events.on("superpowers:phase", …)` — the cross-repo contract.
- `pi.on("before_provider_headers", …)` — gated
  `ctx.model?.provider !== "bifrost"` → return.
- `pi.on("session_start", …)` — unconfigured warning
  (`/login bifrost` guidance).
- OAuth callbacks: `login` (two prompts via `callbacks.onPrompt`), 365-day
  expiry, `refreshToken` (virtual keys don't refresh), `getApiKey`.

### Config & secret handling (preserve exactly)

- Path `~/.pi/agent/bifrost-config.json`, `{gatewayUrl?, virtualKey?}`,
  2-space JSON. Env wins per-field: `BIFROST_GATEWAY_URL`,
  `BIFROST_VIRTUAL_KEY` (trimmed; env+file can mix).
- `saveConfig`: merge over existing; `mkdirSync` parent at 0700 but **never
  chmod an existing dir**; `writeFileSync` mode 0600 **plus explicit
  `chmodSync(0o600)`** (write mode only applies at creation). Failure log
  prefix `[pi-bifrost]`.
- `loadConfig`: separate `try { chmodSync(path, 0o600) } catch {}` — the
  self-heal is deliberately isolated so a chmod failure never discards the
  parsed config (repairs a pre-existing 0644 file in place).

### Model mapping (the Responses-API design)

- `fetchModels(url, key?)`: `GET ${base}/v1/models`, `Authorization: Bearer`
  if key; non-OK throws `GET /v1/models → HTTP <status> <statusText>`.
- `toProviderModel(m, url)`: `api: "anthropic-messages"` +
  `baseUrl: ${url}/anthropic` iff id starts `anthropic/`; else
  `api: "openai-responses"` + `baseUrl: ${url}/v1`. **Never a `compat` flag**
  (test-pinned). Reasoning detection: `pricing.internal_reasoning > 0`, else
  exclude-substring list (embed/whisper/tts/audio/…) then ordered include
  regexes (o-series, gpt-5, claude-4, gemini-2.5+, deepseek-v/r, kimi-k2.5+,
  reasoner, thinking, …). Input modalities from
  `architecture.input_modalities` (image → `["text","image"]`). Cost:
  per-token USD strings × 1M for input/output/cacheRead/cacheWrite.
  `contextWindow` from `context_length` else fallback by id (deepseek-v3+ →
  1M, kimi-k3 → 1,048,576, kimi-k2 → 262,144, else 128k). `maxTokens` from
  the model else **32,768 for reasoning models** (so thinking+text fit the
  output budget — a real DeepSeek-on-Fireworks bug) else 4,096.
- Provider registration: `apiKey: "$BIFROST_VIRTUAL_KEY"` (env reference
  string), `authHeader: true`, provider-level `api: "openai-responses"`,
  empty `models` array on discovery failure (provider still registers);
  startup discovery failure warns `[pi-bifrost] Model discovery failed (…)`.

### Phase header (wire contract — preserve exactly)

- Module-global `superpowersPhase`, updated via the same reducer as langfuse
  (`applyPhaseUpdate`: verbatim retention, trim only for the emptiness test).
- `before_provider_headers` (bifrost-gated):
  `event.headers["x-pi-session"] = path.basename(ctx.cwd)` — looked up
  **live at request time** (worktree name as session identifier);
  `event.headers["x-superpowers-phase"] = <phase>` **omitted entirely when
  unset** (never empty value).

### Packaging/tests

`pi-bifrost` 0.1.0; `pi.extensions: ["./index.ts"]`; single `test` script
(node --import tsx --test); peers pi-coding-agent + pi-ai; committed lockfile.
Tests (3 files, 23 behaviors): config perms (0600 on save, 0644→0600 self-heal
with merge preserved, existing dirs untouched, missing file → `{}` and NOT
created, env override); phase reducer; model mapping (both API routes, no
compat, image modalities, price ×1M, reasoning→≥32k maxTokens, context-window
fallbacks + no-override of reported values). Module import is side-effect-free.

## 2. langfuse — tracing with Superpowers phase metadata

One complete Langfuse trace per pi agent run: root **`pi-agent`** observation
(`asType: "agent"`), one **`turn`** span per turn, one **`llm-generation`**
observation per provider request (fallback generation synthesized from
`turn_end` when none), one **tool** observation per tool call (keyed
`toolCallId`), one **`session_compact`** span per compaction.

### Extension points (registration order)

4 commands (`langfuse-setup`, `langfuse-test`, `langfuse-status`,
`langfuse-privacy`) + `pi.events.on("superpowers:phase")` + `pi.on` for:
`session_start` (reset + ensureConfig), `model_select` (record model),
`before_agent_start` (startAgentRun), `agent_start` (**system prompt captured
here, not earlier — later handlers can rewrite it**), `before_provider_request`
(startGeneration), `after_provider_response` (ERROR level + end on
status ≥ 400 / event.error / event.isError), `message_update` (TTFT +
latestAssistantOutput), `message_end` (finish generation),
`tool_execution_start` **and** `tool_call` (dual subscription, dedup by
toolCallId), `tool_result` **and** `tool_execution_end`, `turn_end` (turn
count, fallback generation, finish), `agent_end` (finish + awaited
shutdownRuntime), `session_before_switch`/`session_before_fork`,
`session_compact`, `session_shutdown` (interruption handling: dangling
observations closed WARNING, root `metadata: {completed: false, cancelled:
true}`). Every handler wrapped `withSession(ctx, fn)` — session id via
AsyncLocalStorage with sessionManager fallbacks.

### Config, privacy, redaction

- `~/.pi/agent/pi-langfuse/config.json` (0700 dir **chmod'd even when
  existing** — unlike bifrost, 0600 file). Env: `LANGFUSE_PUBLIC_KEY` +
  `LANGFUSE_SECRET_KEY` (both required to enable), `LANGFUSE_BASE_URL` >
  `LANGFUSE_HOST` (default `https://cloud.langfuse.com`),
  `LANGFUSE_TRACING_ENVIRONMENT`. File `capture`/`privacyPreset` merge under
  real env. One interactive setup attempt per session; headless → console
  guidance.
- **Privacy presets** (`LANGFUSE_PRIVACY_PRESET`, default `full-debug`):
  `metadata-only` / `prompts-only` / `conversations` / `full-debug`; boolean
  overrides `LANGFUSE_CAPTURE_{INPUTS,OUTPUTS,TOOL_IO,SYSTEM_PROMPT,CWD}`.
  Metadata always captured but redacted; `cwd` dropped when its capture is
  off.
- **Redaction** (order matters): PEM private keys → `[REDACTED_SECRET]`;
  `Bearer <12+>`; token shapes (`sk-(lf|ant|proj|live|test)`, `pk-lf-`,
  `gh[pousr]_`, `npm_`, `AKIA…`); secret assignments (`KEY=value` for
  SECRET/TOKEN/PASSWORD/API-KEY/… names); absolute paths →
  `[PATH_HASH:<12 hex sha256>]` (`.env` suffix preserved). Object walk:
  sensitive field names → REDACTED, circular/`[circular]`,
  bigint→string, depth/array/key limits with explicit markers. Sensitive key
  regex and the full sensitive-name list are part of the contract.
- **Limits** (`PI_LANGFUSE_MAX_*`, positive or
  `0/off/none/false/no/unlimited/inf` → Infinity): string 12,000; tool
  payload 24,000; depth 6; array 50; object keys 80; payload nodes 2,000.
  `PI_LANGFUSE_DEBUG`. `shapePayload` = budgeted walk + truncation +
  JSON re-parse + redact.

### The `superpowers:phase` pipeline (the published cross-repo contract)

- Channel `"superpowers:phase"`, payload `{ phase: <string> }`, **no session
  id**; canonical values `brainstorming` / `development` but consumers treat
  values as opaque.
- `src/phase.ts`: `setPhase` (module-global retained phase — **not
  per-session**, one active run at a time), `buildPhaseMetadata()` →
  `{ superpowers_phase: <phase> }`, `buildPhaseTags()` →
  `[phase:<phase>]`, `replacePhaseTags` (drop all `phase:*`, keep the rest,
  append desired — at most one phase tag).
- **Phases appear in exactly five places**: root observation metadata at
  start AND at finish; every generation observation's metadata (read live at
  request time, so a run spanning phases records each request's phase);
  initial trace `tags` at trace creation (omitted when no phase); and
  **live trace tag sync** on every phase event — per-session serialized
  promise chains, dedup by `traceId+tags`, `rt.getTraceTags` →
  `replacePhaseTags` → `rt.updateTraceTags`, failures **silent** (retry on a
  later event; a failed read never triggers a replacement write).
- Phase metadata deliberately never lands on `turn`/`tool` observations.

### Runtime, OTel, network behavior

- Lazy dynamic imports (BasicTracerProvider, LangfuseSpanProcessor,
  AsyncHooksContextManager, tracing, LangfuseClient); one global context
  manager.
- **Local mirror** (`RestFallbackStore`): every trace/observation mirrored
  locally; Langfuse has **no trace-update API**, so tag updates resend a
  `trace-create` ingestion event **with the full known trace fields** from
  the mirror (bare `{id, tags}` only when unknown — that could wipe fields).
- Tag read: bounded 404-only retry (delays 100/250/500/1000 ms, max 5
  attempts); malformed tags → named error.
- **Score pipeline**: evaluation scores `tool_call_count`, `turn_count`,
  `total_tool_errors`, `tool_success_rate`, `session_had_errors` (BOOLEAN for
  `session_had_errors`/`tool_is_error`, NUMERIC otherwise), queue cap 100k,
  flush at 10 or 1s timer (unref'd), batches ≤100, stable score ids across
  retries, failed batches stay queued.
- **REST fallback for an invisible OTel trace** (at shutdown): poll
  `GET /api/public/traces/{id}` ≤1.5 s; classify
  visible/missing/legacy-unsupported/unknown (capability probed once via
  `?limit=1`); **fails closed on ambiguity**; replays the mirrored trace via
  `trace-create`/`span-create`/`generation-create`; once per runtime.
- **Shutdown** under a 2 s total deadline (score flush → pending scores
  (own `PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT`) → OTel force flush → client
  shutdown → REST fallback), failures remembered + warned, never thrown; a
  stalled SDK shutdown never hangs the session (child-process test pins
  this).
- **Unreachable server = never throws into pi**: init failure sets
  `isTracingDisabled` + warn; per-event handler errors caught and warned;
  all log lines prefixed `📊 Langfuse:`.

### Source metadata

`collectSourceMetadata(cwd)`: synchronous `execFileSync("git", …)` (2 s):
`--is-inside-work-tree`, `--show-toplevel`, `HEAD`, `branch --show-current`,
`config --get remote.origin.url` → `{source_type: "git-repo", repo_root_name,
git_branch?, git_commit, git_remote_host?…}` or
`{source_type: "non-git"}`. `.pi-langfuse.metadata.json` override file
walked cwd→git root (whitelisted string keys; sets `metadata_source:
"repo-file"`). *(Note: this is one of the VCS-coupled spots — under the jj
hybrid it still works colocated; `git_branch` will read empty when HEAD is
detached — a small pi-carte-side consideration.)*

### Commands

`/langfuse-status` (state, masked key, preset, last error; rejects args);
`/langfuse-privacy [preset]` (validates the 4 presets; UI picker; persists
via saveConfig; env flags still override); `/langfuse-test` (connectivity
check `GET /api/public/projects` Basic-auth 10 s first; skipped during an
active run; sends a `pi-langfuse-test` span; force-shutdown after).

### Packaging/tests

`pi-langfuse-plus` 0.1.0; `typecheck` + `test` scripts (gate runs both);
committed lockfile; `types/` shims exist so tsc runs without pi's real types
(structural ExtensionAPI/EventBus decls + OTel/Langfuse shims — the
production code's `data as {phase: unknown}` guards exist because the shims'
EventBus signatures are wider than real pi types). 15 test files, ~110 tests
— notable pins: the phase channel literal; tags omitted when no phase;
concurrent sessions never cross trace ids; tag-sync silence; shutdown-deadline
behavior incl. a spawned-child stalled-fetch fixture; visibility-retry bounds
(404→3 reads, non-404→1, exhaustion→5); REST fallback fails closed; the
root-dep mirror test. Isolation tricks: fake ExtensionAPI objects,
`__setRuntimeForTest` seam, `globalThis.fetch` monkey-patching,
`clearAllSessionStates()`, save/restore `state.config` in try/finally.

## 3. Preserve-EXACTLY checklist (the as-is port contract)

Event channel `superpowers:phase` + payload key `phase` (values opaque);
headers `x-pi-session` (= basename of ctx.cwd, live lookup) and
`x-superpowers-phase` (omitted when unset); Langfuse metadata key
`superpowers_phase`; tag namespace `phase:`; the tag replacement rule;
provider id `"bifrost"`; `api` strings + baseUrls; `apiKey:
"$BIFROST_VIRTUAL_KEY"`; both config paths/shapes and the exact chmod
mechanics (incl. bifrost's isolated self-heal and no-chmod-existing-dir
rule, langfuse's chmod-existing-dir rule); every env var name as listed;
`applyPhaseUpdate` semantics (identical in both packages); ingestion
endpoints `/api/public/ingestion`, `/api/public/traces/{id}`,
`/api/public/traces?limit=1`, `/api/public/projects`; Basic auth
`base64(pk:sk)`; retry schedule [100,250,500,1000]; all numeric
defaults/timeouts; observation names `pi-agent`/`turn`/`llm-generation`/
`session_compact`/`pi-langfuse-test`; asTypes; score names + the
BOOLEAN/NUMERIC mapping; log prefixes `[pi-bifrost]`, `📊 Langfuse:`,
`[REDACTED_SECRET]`, `[PATH_HASH:…]`; agent_start-time system-prompt capture;
dual tool-event subscription; turn_end fallback generation.

## 4. Known debt / caveats (port-aware)

- `AgentState.providerMetadataByRequest` is dead (never read/written) — port
  it anyway; tests construct it.
- Upstream provenance: fork diverges from `gooyoung/pi-langfuse` @ `c79c527`
  (phase tags, tag retry, score hardening, capture policy, limits) — a
  wholesale upstream re-sync would lose those.
- Tag updates rely on `trace-create` upsert with full field resend (server
  merge semantics unguaranteed; the local mirror makes it safe).
- Bifrost reasoning detection + context-window fallbacks are naming-pattern
  heuristics — they silently miss new model families (documented).
- The phase contract carries no session id — the retained phase is
  module-global; per-session safety is only the tag-sync chain serialization
  (and bifrost's header is global per process).
