# 06 — pi-subagents: feature inventory

Source: `packages/pi-subagents/` — vendored fork of `tintinweb/pi-subagents`
(v0.19.0 base), owned by this repo. 4,608-line `src/index.ts` + ~50 modules +
110 test files. Divergences from upstream are recorded in
`docs/pi-subagents-local-patch.md` (10 numbered divergences — summarized in §8).

> **UI posture lens (from 00 §1a)**: this package's TUI surfaces — AgentWidget,
> FleetView, ConversationViewer — are the prime **drop candidates** in a
> Rex-pane-based stack. §4 marks them accordingly. The record/tools/events
> machinery is the keep/redisign surface.

## 1. Architecture

Two execution modalities behind one seam:

- **In-process** (default): each subagent is a full SDK `AgentSession` built by
  `runAgent()` (`src/agent-runner.ts`) — own resource loader, session manager,
  settings, system prompt, tool scope, model, thinking level.
- **Rex panes** (inside Rex): each subagent is a **real `pi` process** in a
  minimized floating pane (`src/rex/`). **The seam**: `RunHandle` interface
  (`messages, subscribe, getSessionStats, sessionFile, prompt, steer, abort,
  dispose`, optional `model/thinkingLevel/extensionRunner`) + injectable
  `ManagerRunner` (`start/resume/close/closeAll`); `AgentManager` owns records,
  runners own run loops; `runnerFor` picks the modality per spawn.

Claude Code compatibility is a design goal throughout: tool names
(`Agent`, `get_subagent_result`, `steer_subagent`), `<task-notification>` XML,
`@handle` mentions, badges/spinner rows/`⎿` result lines, verbatim
`<system-reminder>` wording.

**Entry guards**: the factory returns immediately if already inside a child
session (`inChildSessionContext()`) or if `PI_SUBAGENTS_CHILD_SPEC` is set
(Rex pane child → install child mode instead of a second manager).

## 2. Tools

### `Agent` (exposure `direct`, deliberately NOT in the `subagents` namespace)

Params: `prompt`, `description` (3–5 word UI summary), `name?` (memorable
handle `@auth-audit`), `subagent_type` (required; description embeds the live
available-types list), `model?` (`provider/modelId` or fuzzy, trailing
`-YYYYMMDD` date stamps tolerated), `thinking?` (off/minimal/low/medium/high/
xhigh/max), `max_turns?`, `run_in_background?` (default **true**), `resume?`
(agent id **or** handle; evicted records reopen from disk, result says
`resumed from disk`), `isolated?`, `inherit_context?`, `isolation?
("off"|"worktree")` (param omitted entirely when `worktreeIsolation: false`),
`schedule?` (6-field cron / `5m`-style interval / `+10m` or ISO one-shot;
forces background; incompatible with `resume` and `inherit_context`).

Semantics: reload custom agents (mid-session pickup) → `resolveSpawnType`
(the single fallback decision point: unknown/disabled/case-ambiguous types
either fall back per `fallbackSubagent` with a `Note:` prefix or **fail
closed** listing available types) → invocation config (**frontmatter outranks
parameters** for model/thinking/max_turns/inherit_context/run_in_background/
isolated/isolation; overrides disclosed as `(asked X)`) → model resolution
(exact → fuzzy → provider fallback → error listing available models; hard
error when caller-supplied, silent inherit when frontmatter-pinned) → model
scope check (caller-supplied out-of-scope = hard error; frontmatter/inherited
= warning) → schedule branch / resume branch / spawn. Background spawn returns
id immediately + identity lines (`Agent ID: <id>` / `Handle: <alias>`) +
"Do not duplicate this agent's work." Foreground streams (spinner 80 ms,
stats line, queue reporting).

Tool description: `full` (~1,400 tokens, byte-pinned by test + mirrored in
`examples/agent-tool-description.md`), `compact` (~75% smaller), or `custom`
from `agent-tool-description.md` with placeholders
(`{{typeList}}`, `{{compactTypeList}}`, `{{agentDir}}`, `{{isolationGuideline}}`,
`{{scheduleGuideline}}`). promptGuidelines: match types / Explore for broad
exploration / don't poll background agents / trust-but-verify.

### `get_subagent_result` (exposure `codemode` + `subagents` namespace + outputSchema)

`{agent_id, wait?, verbose?}`. **Resolution ladder**: live by id → live by
handle → **tombstone** (identity only, `status: "evicted"`, prose names
`Agent({ resume: "<handle>" })`, **never spawns**) → **`wf_…` workflow run**
(live / rehydrated-at-session-start / `interrupted` → `status: unknown`) →
not-found. `wait: true` polls queued records (50 ms) then races Esc
(cancels only the wait). Marks `resultConsumed` and cancels the pending
notification nudge. `verbose` appends the formatted conversation.

### `steer_subagent` (exposure `codemode` + namespace)

`{agent_id, message}`. Live running records only; not-ready sessions queue the
message ("if the agent refuses it, you will be notified"). For pane runs,
delivery is `rex send` + `send-key enter` gated on program-status whitelist
`{working, idle}`; newline/control chars refused.

### `SubagentWorkflow` (exposure `deferred` + namespace)

Registered only when enabled; **stands down** (withdraws via `setActiveTools`)
if another extension already registers a same-name workflow tool. Params:
`script` (≤512 KiB) / `scriptPath` (wins) / `name` (saved workflow) /
`args` (must be object/array — pre-flight shape guard) / `resumeFromRunId`
(`^wf_[a-z0-9-]{6,}$`) / `title`+`description` (accepted-and-ignored, CC parity).

**Script runtime**: worker thread + `node:vm` context. Globals: `agent(prompt,
opts?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`,
`log(msg)`, `workflow(nameOrRef, args?)`, `budget`, `console`, `meta`, `args`.
Determinism prelude: `Date.now`/`Math.random`/argless `new Date`/`eval`/
`Function()` throw. JSON boundary check (cycles, BigInt, symbol, function,
non-finite, sparse arrays rejected). `agent()` options: `label`, `phase`,
`model`, `agentType`, `isolation: "worktree"`, `gate` (shell command; non-zero
exit fails the agent; runs inside the worktree), `resume: "<label>"`,
`effort`, `schema` (JSON Schema ≤64 KiB, one validation retry), `stallTimeout`.
Caps: concurrency `max(1, min(16, cpus−2))`; 1000 agents; 4096 items; 256
nested; default stall timeout 600 s (run-level window = 2× child, suspended
while paused or children in flight). Run controls: `x` stop, `p` pause/resume,
`s` skip (null), `r` retry, `c` open conversation. **Journal/resume**: prefix
replay keyed by position + sha256-of-canonical-payload; journaled failures and
any `agent({resume})` usage end the cache. CLI flag
`pi --subagents-workflow-file=<path>` renders a session entry with the result
delivered next turn. Saved workflows (`name`), collision handling, progress
tracking, meta extraction (pure-literal `meta`, 100 ms vm bound).

### Nested delegation tools (`src/nested-tools.ts`)

Same three tool names injected as `customTools` into a child session when the
agent type sets `allowed_subagents` (non-empty; `"all"`/`"*"`/`true`/CSV) and
the run is not `isolated` and below `maxSubagentDepth` (default 2; 0/1 = off;
at the cap **nothing** is injected). Nested `run_in_background` defaults
**false** (a detached child dies with its parent). Strict type resolution
(never the fallback policy). **Ownership-scoped**: every lookup checks
`parentAgentId`; nested children get no handle/tombstone, are hidden from
top-level surfaces, stopped with their parent, take no pool slot, transcripts
filed under the ROOT session's task dir. Usage folds into every ancestor's
`lifetimeUsage`.

### `/agents` command

Menu: Running agents / Agent types (source indicators `•`/`◦`/`✕`, model
column with fallback annotations) / Scheduled jobs / Workflows / Create-new
wizard (manual or AI-generated) / Settings (~22 rows). Agent detail:
Eject/Disable/Enable/Reset/Delete/Edit (BOM/CRLF-preserving file edits).

## 3. Agent types

- **Built-ins** (`general-purpose` = parent twin, append mode; `Explore` =
  read-only search specialist, replace mode, pinned haiku model; `Plan` =
  architect, ends with "Critical Files for Implementation"). Defaults can be
  ejected/overridden/disabled/suppressed.
- **Custom agents**: markdown + YAML frontmatter, discovered last-write-wins
  from `<agentDir>/agents/` → `<cwd>/.agents/agents/` → `<cwd>/.pi/agents/`.
  Frontmatter: `name` (the type; filename fallback), `display_name`, `color`,
  `tools` (CSV/`*`/`ext:<ext>` selectors), `extensions` (true/false/CSV/`*`),
  `exclude_extensions` (exclude wins), `skills` (true/false/CSV),
  `model`, `thinking`, `max_turns`, `persist_session`, `output_transcript`,
  `session_dir`, `allowed_subagents`, `prompt_mode`, `inherit_context`,
  `run_in_background`, `isolated`, `memory` (user/project/local),
  `isolation`, `enabled`. Unparseable files skipped with a warning;
  `strictAgentFiles: true` makes the initial load **fail startup**.
- **Registry**: case-insensitive resolution that refuses to guess between
  case-variants; one shared fallback decision point for Agent tool, scheduler,
  RPC, and nested tools.
- **Memory** (`memory.ts`): scoped `MEMORY.md` index + per-memory files;
  read-write vs read-only memory decided by effective write/edit tools.
- **Skills** (`skill-loader.ts`): `skills: [a,b]` **preloads content into the
  prompt** (in-process); discovery across 5 roots, flat-file/`SKILL.md`/BFS
  recursive; **symlinks rejected at every layer**; unsafe names rejected;
  `findSkillPath` variant for pane children (path, not text).
- **Output transcripts** (`output-file.ts`): JSONL at
  `<tmpdir>/pi-subagents-<uid>/<encoded-cwd>/<sessionId>/tasks/<agent-id>.output`
  (0700); entries `{isSidechain, agentId, type, message, timestamp, cwd}`;
  flushed on `turn_end`, re-anchored on compaction; `sessionTaskDir` shared
  with workflow scripts/journals and pane child files.

## 4. UI / TUI (⚠ drop candidates under the Rex-pane posture — [decide] Q11)

1. **AgentWidget** (above-editor, 12-line cap, braille spinner, ~200 ms tick;
   rows: name, description, `↻N≤M` turns, tool uses, tokens + color-coded
   context %, `⇊N` compactions, `~$cost`, elapsed; `⎿ live tool activity`
   sub-line). Modes all/background/off.
2. **FleetView** (below-editor rows, `↓`/`←` to enter, 5-row cap, finished
   linger 4 s, Enter opens viewer).
3. **ConversationViewer** (70% viewport overlay; live auto-follow; Enter =
   steer composer; `x`+`x` stop; `m` markdown cycle; per-agent header with
   canonical model + thinking disclosure).
4. **`@` mention provider** (stacked autocomplete: running, resumable
   tombstones, startable types).
5. **Workflow surfaces**: inline card (phase tree, per-agent `✔/⟳/✘/⏸`, `⚠
   Large workflow` above 25 agents/1.5M tokens), two-pane inspector
   (phases→agents→detail, `f` filter, x/p/s/r/c keys), `/agents → Workflows`
   run picker.
6. **Schedule menu** (list/cancel/toggle with next-run details).
7. **Notifications**: completion nudges held 200 ms so `get_subagent_result`/
   RPC-consume can cancel them; delivered as `followUp` custom message —
   **LLM sees `<task-notification>` XML** (task-id, tool-use-id, output-file,
   status, summary incl. modality note, result preview 500/300 chars, usage);
   user sees the styled box. **Group joins**: `smart` (default; ≥2 same-turn
   spawns auto-group), `async`, `group`; 30 s group timeout then partial
   delivery. *(Notifications are model-facing, not just TUI — they survive a
   UI-drop decision; only the styled box rendering is TUI.)*

## 5. Events / hooks / RPC

**Emitted on `pi.events`** (top-level only for the four agent events):
`subagents:created` `{id, type, description, isBackground}` (Agent-tool
background spawns + detached resumes only),
`subagents:started`, `subagents:completed`/`failed` (`{id, type, description,
result, error, status, toolUses, durationMs, tokens, usage}` — consumed by
pi-beads cost tracking), `subagents:steered`, `subagents:compacted`,
`subagents:scheduled`, `subagents:scheduler_ready`, `subagents:ready`,
`subagents:settings_loaded/changed`.

**Session entries**: `subagents:record` on every top-level settle;
`subagents:workflow` on workflow settle (rehydrated at `session_start`;
interrupted runs → `status: unknown`).

**Host hooks consumed**: `session_start` (ctx capture, workflow rehydration,
RPC wiring, scheduler, mention provider, collision check, CLI flag),
`session_before_switch` (clearCompleted + scheduler stop), `session_shutdown`
(RPC teardown, registry release, scheduler stop, workflow aborts,
`abortAll()`, awaited `dispose` incl. pane closeAll), `input` (mention
dispatch), `tool_execution_start` (widget turn tracking).

**Cross-extension RPC** (`docs/rpc.md`, protocol v2): channels
`subagents:rpc:ping|spawn|stop|consume` over `pi.events`; spawn resolves
models at the boundary + hard scopeModels error; stop refuses owned/settled
agents; consume suppresses a notification. Global
`globalThis[Symbol.for("pi-subagents:manager")]` registry, first-activation
claim.

## 6. Execution details

### AgentManager

- **Two independent pools**: background `maxConcurrent` (default 10),
  foreground `maxConcurrentForeground` (0 = unlimited). Nested and workflow
  children take no slot. One shared queue; pool decided once at start.
- Statuses `queued | running | completed | steered | aborted | stopped |
  error`; settle precedence: user-stop preserved → hard abort → final-turn
  failure (provider error, or `length` stop with no text → `error` with
  partial output) → `steered` (soft limit, finished in grace) → `completed`.
- **Record GC 10 min after settle** (60 s sweep) with **tombstones**
  (`MAX_TOMBSTONES = 100`: handle, alias, id, type, description, sessionFile,
  completedAt) for `@handle` reopen; cleared on session start/switch;
  `planReopen` guards (session file exists else `session-gone`; type still
  resolves else `type-unavailable`).
- Resume ladder; steer queues on `pendingSteers`; steering refusals propagate
  as warnings, never swallowed. `dispose`: dequeue-all, prune worktrees,
  stop pane runs, drain `closeAll`, then awaited child-session shutdown with
  a 3 s per-handler ceiling (child extensions get a real `session_shutdown`
  emit — without it, `session_start` timers leak and kill pi).

### runAgent (in-process)

- `DefaultResourceLoader` with `noPromptTemplates/noThemes/noContextFiles`,
  `systemPromptOverride`, `extensionFactories: [createCodemodeExtension(),
  createToolScopeVeto()]` — suppresses AGENTS.md etc. so `prompt_mode:
  replace` and `isolated` actually hold.
- **Extension scoping**: `false` → `noExtensions`; list → loader allowlist
  (paths resolved, canonical/package names matched); `exclude_extensions`
  subtracts (exclude wins); **inline factories exempt** so codemode survives.
  Errors surface as synthetic tool activity (`tools-error:…`).
- **Tool scoping**: static allowlist under noExtensions/isolated; otherwise
  denylist + live `inScope()` re-derivation per `turn_end` (lazily-registering
  extensions), a `beforeToolCall` wrap, and the `tool_call` veto extension
  enforcing the same predicate on **nested codemode calls** (fail-open direct
  before scope install, fail-closed nested). Re-admitted names: nested
  delegation tools, StructuredOutput, `codemode`. One veto wording:
  `Tool "X" is not available to this subagent.`
- **Prompt build**: `<active_agent>` tag, env block (cwd/git/branch/platform),
  `<worktree_isolation>` block, `<workflow_child>` block, `<sub_agent_context>`
  bridge, `<agent_instructions>`, memory blocks, `# Preloaded Skill:` blocks.
- **Turn limiting**: steer `WRAP_UP_STEER` at the limit, hard abort after
  `graceTurns` (default 5).
- `inherit_context` prepends a rendered parent-conversation context
  (compaction-aware). Session naming `<name>#<agentId.slice(0,8)>`; nested
  under the spawner in `/resume` when persisted.

### Worktree isolation (`src/worktree.ts`) — VCS-coupled (see 02)

`git worktree add --detach <tmpdir>/pi-agent-<id>-<hex> HEAD` (monorepo cwd
maps to the same subdir in the copy). **Failure is strict**: a failed tool
call, never an unisolated run. Cleanup: commit changes
(`add -A && commit --no-verify`, branch `pi-agent-<id>` with collision
suffix), remove worktree, result names the merge command; unchanged HEAD →
remove, no branch. `onBeforeWorktreeCleanup` hook (workflow gates).
`worktreeIsolation: false` drops requests silently and removes the param.

### Rex panes (`src/rex/` + `docs/rex-panes.md`) — the Q10/Q11 centerpiece

- **Detection** (memoized per process): not a child + `REX_SESSION`/
  `REX_BLOCK` set + stdout TTY + setting ≠ off + `rex whoami --json` probe
  (1.5 s timeout, SIGKILL). One pane runner per root session.
- **Launcher**: `ChildSpec` JSON (agentId = child session id, rootSessionId,
  parentAgentId, depth, maxSubagentDepth, allowedSubagents, resultPath, cwd,
  configCwd, maxTurns, structuredSchemaPath, extSelectors, toolScope, model,
  thinking, pane ids) + `system.md` + `prompt.md` in `<taskDir>/<agentId>/`;
  child argv = `/usr/bin/env PI_SUBAGENTS_CHILD_SPEC=<spec> <piBinary>
  --session-id/--session … -a|-na --system-prompt|--append-system-prompt
  <system.md> <confinement flags> --provider --model [@prompt.md]`.
  **Confinement as CLI flags** must match in-process semantics:
  `isolated` → `-ne -ns -nc --no-mcp`; extensions list → `-ne` + `-e <path>`
  per survivor + `-e builtin:codemode` (and `builtin:tool-search`) when the
  parent had them; skills list → `-ns --skill <path>`; `configCwd` has no
  flag — rides in the spec, child warns once. Trust: `-a` only when the
  parent trusts the project AND the child cwd is inside it.
- **Pane mechanics** (verified against Rex): `session.new_layer` floating,
  `focus: false`, `exit.on_completion: true`, **no `shell` key** (with
  `login: true` a `"shell": "none"` reports exit 0 for every outcome),
  cascading bounds (6 lanes, origin (0.55, 0.08), size **0.42 × 0.12** — i.e.
  42% width × **12% height**); create+minimize serialized through one queue;
  `session.set_layer_state {minimized}`; `session.close_layer`
  (not_found = already closed = success). **User feedback (2026-11-02): panes
  at 12% height are too small to see anything** — real-world use confirms the
  spec's own numbers; pi-rex must revisit `paneBoundsForIndex` (larger bounds,
  grid vs cascade, configurable sizing, or lean fully on minimized capsules +
  expand-on-demand).
  **Known bug (diagnosed 2026-11-02, live): `watchExit` misreads `rex wait`'s
  window timeout as unreachability.** `rex wait -s <session> <block> --json
  --for <ms>` on a still-running child exits **1** with empty stdout and stderr
  `Error: wait timed out … context deadline exceeded` — timeout-as-error, no
  payload. `replyBody` gets nothing, `readProcessState` correctly reports
  `last_exit: null` (running, but null means keep-going), `paneIsGone` only
  matches `/not found/i` — so the first expired 30 s window of any long-running
  pane triggers the spurious warning `the pane for "<label>" could not be
  reached while watching it … the run will be settled from the child's result
  file`. The run still completes (result-file settle works); the warning is
  false and misleading. Fix: classify the timeout (`stderr` matching
  `/wait timed out|context deadline exceeded/i`, or non-zero exit + empty
  stdout + that pattern) as normal window expiry and loop silently; warn only
  when rex wait fails non-timeout AND the `block call process` fallback also
  fails. The design doc verified only the `child_exited` payload path — the
  still-running path was never exercised against the real CLI.
- **Run/finish**: settle = first of result-file poll (100 ms, atomic
  write-temp-rename on `agent_settled` → `ctx.shutdown()` — the child exits
  and the pane closes itself) vs `rex wait --json` (fallback `block call
  process` / `program_status`). Exit-without-result → error with exit status,
  last assistant text, captured pane tail (40 lines). Live state from a
  **JSONL tail** of the child's own session file (usage, tool activity, turn
  counts, compactions; **no text deltas**; no `contextUsage` — honest
  absence). Steer = `rex send` + `send-key enter` gated on
  `{working, idle}`. Abort = close layer. Resume relaunches on
  `--session <file>` (**throws if no pane — never falls back**, unlike
  start). Schema round-trip failure → in-process fallback reported as
  `paneFallback` + warning (`getModalityNote`).
- **Child mode**: reads and deletes `PI_SUBAGENTS_CHILD_SPEC`; registers its
  own nested tools + manager, structured output, tool scope, turn cap,
  result writer, self-shutdown. No root registration, no scheduler, no
  widget, no `/agents`, no panes of its own.

### Scheduling

Croner cron / intervals / one-shots; session-scoped store at
`<cwd>/.pi/subagent-schedules/<sessionId>.json` (PID lock with dead-PID
reclaim, atomic temp+rename). Fires re-resolve type+model at fire time,
`bypassQueue` spawns; events; one-shots auto-disable.

### Mentions

`@handle` grammar + roster; `@main` escape hatch. Running → steer; finished →
background resume; tombstone → reopen; type name → **model mode** runs a
mention clone (off-screen in-memory session: same entries, same system
prompt, one tool — the registered Agent tool re-bound to the main ctx) or
**direct mode** spawns immediately.

## 7. Settings (all keys + defaults)

Global `<agentDir>/subagents.json` merged under project
`<cwd>/.pi/subagents.json`; per-field sanitize with ceilings; compile-time
completeness guard. Keys: `maxConcurrent` 10, `maxConcurrentForeground` 0
(unlimited), `defaultMaxTurns` 0 (unlimited), `graceTurns` 5,
`defaultJoinMode` smart, `backgroundByDefault` true, `schedulingEnabled`
true, `scopeModels` false, `strictAgentFiles` false, `disableDefaultAgents`
false, `toolDescriptionMode` full, `fleetView` true, `agentMentions` model,
`rememberAgents` true, `widgetMode` background, `outputTranscript` true,
`worktreeIsolation` true, `workflowsEnabled` true (auto-stand-down),
`maxSubagentDepth` 2, `fallbackSubagent` undefined (general-purpose; `"none"`
= strict), `reportUsage` false, `showCost` false, `showModel` false,
`viewerMarkdown` assistant, `runInRexPanes` auto, `workflowStallTimeoutSecs`
600.

Env vars: `PI_CODING_AGENT_DIR`, `PI_SUBAGENTS_CHILD_SPEC`, `REX_SESSION`,
`REX_BLOCK`, `PI_CODING_AGENT_SESSION_DIR`, `PI_E2E_LIVE` (test). Reads pi's
own `enabledModels` from project/global settings.

## 8. Local divergences from upstream (10, from docs/pi-subagents-local-patch.md)

1. typebox as peers (not deps) — unblocks the dep-mirror gate.
2. Ported to `@earendil-works/*` 0.99.1 (upstream 0.84.2).
3. Codemode exposure/namespace/structured output for the three companion
   tools (`Agent` deliberately unchanged, namespace-less).
4. **Codemode activation inside subagent sessions** (inline factory + allowlist
   exemption + readmission + nested-call scope veto).
5. Mention-clone transcript seeding on the 0.99.1 API.
6. Workflow `args` shape guard (pre-flight + runtime).
7. Workflow stall watchdog + `wf_` result lookup + durable terminal state +
   session-start rehydration of runs.
8. Durable id + resume ladder (identityLines everywhere; tombstone branch in
   get_subagent_result).
9. Nested dispatch results carry the child's id.
10. **Rex panes** (the whole `src/rex/` subtree + child mode + the
    `RunHandle`/`ManagerRunner` seam + `runInRexPanes` setting).

Marker convention: `// LOCAL PATCH (pi-packages) — see
docs/pi-subagents-local-patch.md` (+ divergence number).

## 9. Tests (110 files) — what's pinned

Manager/GC/races (resultConsumed race, registry guard, #242 child-session
shutdown, startup failures fail the tool call); registry/files (BOM, toggle,
strict wiring, fallback wiring); invocation (precedence, model resolution
fuzzy/date-stamps, scope, `(asked …)` disclosure, background-by-default);
resume/identity (the full ladder, tombstone no-spawn, queued reopen, stale-id
guard); nested (inline shapes, no Handle:, e2e with real pi-mono);
runner (final-output capture, codemode activation block, async registration +
veto); status/usage; mentions (byte-identical refusals, clone); RPC
(envelopes, error strings, #142 lifecycle gating); scheduling (real timers);
**workflows (23 suites** incl. Claude-Code-compat script verbatim, examples
all executed, journal replay, stall wiring, gate-in-worktree, pause/entry
snapshot); output/prompts/memory/skills/context; UI; **Rex (9 suites**:
detect, launcher argv + confinement fixtures, cli seam, session tail, pane
session, child mode, run-handle seam, pane-run, integration with a fake rex
harness); e2e/ (9 real-session suites incl. codemode-nested-scope with the
real QuickJS executor); perf invariants (no-FS-on-render, render cost linear,
one Agent call = one sweep of agent directories).

## 10. Packaging

`@tintinweb/pi-subagents` 0.19.0; peers `@earendil-works/*` ≥0.99.0 +
typebox pair; deps `croner`, `nanoid` (mirrored at root for the dep-mirror
gate). Scripts: `check` = biome + `tsc --noEmit` + `vitest run`; `test:e2e`;
`bench`. Package CI also has a `compat-floor-pi` job at 0.84.0 — **stale vs
divergence 2's ≥0.99.0 peers**; a re-vendor must reconcile. In-repo docs:
`README.md`, `docs/workflows.md`, `docs/rpc.md`, `docs/rex-panes.md`,
`AGENTS.md` (dev rules), `examples/agent-tool-description.md` (byte-identical
mirror), `examples/workflows/*.js` (all executed by tests).

## 11. New-repo considerations

1. **Q11 is the big one**: with panes as the UI, the drop list is AgentWidget,
   FleetView, ConversationViewer (+ their formatters/wiring tests), and the
   mention autocomplete provider is a maybe. The **keep/redisign** list:
   identity + resume ladder + tombstones, `get_subagent_result`/
   `steer_subagent`, notifications (model-facing `<task-notification>` XML),
   the RPC surface, scheduling, mentions dispatch, workflows, the `RunHandle`
   seam. The (implemented, live-by-default-inside-Rex) design's consequence list applies: grandchildren not in
   the parent's `/agents` (needs a record home), per-process pools, startup
   cost per agent, usage at settle, confinement-as-flags with the
   provider-extension caveat (`--provider` unresolvable when the extension is
   excluded), subagent sessions leave `/resume` (dedicated store under
   `<agentDir>/subagent-sessions/<rootSessionId>/`).
2. **Pane-only?** The current design keeps the in-process runner as fallback
   (auto-detect). A no-fallback stack could make Rex a hard requirement —
   the design doc's fallback matrix (§7 of the spec) then becomes an error
   matrix. That deletes `agent-runner.ts`'s session creation… but nested
   tools, structured output, tool-scope veto, and prompt build are shared and
   still needed (delivered as files/flags instead).
3. **Two Rex-pane bugs to fix in pi-rex v1 (both diagnosed)**: (a) pane bounds —
   42% × 12% is too small to read (user feedback, above); (b) the `watchExit`
   timeout misclassification (above) — spurious "could not be reached" warning on
   every pane run longer than one 30 s window.
4. The **launcher/confinement mapping is the highest-risk port surface**
   (the design doc itself names it: "the task where a wrong guess quietly
   weakens an agent type") — keep the fixture-driven tests that assert flag
   mappings against the same agent files the in-process tests use.
4. `worktree.ts` is the jj coupling (02 §2): `jj workspace add --colocate` is
   the clean 1:1 mapping; branch-per-worktree becomes bookmark creation.
5. The workflow determinism prelude, boundary check, journal replay, and
   stall watchdog are all independently valuable — they carry over regardless
   of UI decisions.
6. The **conversation viewer** may still be wanted as a *record* surface for
   finished agents (transcripts outlive panes) — possibly as a pane running
   a viewer command rather than an in-TUI overlay.
