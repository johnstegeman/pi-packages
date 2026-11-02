# Subagents in Rex panes — Design

Status: draft (awaiting spec review and partner approval)
Package: `packages/pi-subagents`
Date: 2026-11-02

## Context

`packages/pi-subagents` is our vendored fork of `tintinweb/pi-subagents`. Today every
subagent is an **in-process SDK session**: `AgentManager.spawn()` creates an `AgentRecord`,
`runAgent()` (`src/agent-runner.ts:693`) builds one with `createAgentSession()`
(`src/agent-runner.ts:1105`), prompts it, and streams its events into the parent's TUI —
the live widget, the FleetView list, the conversation viewer, and `/agents`. The package has
no `rex` integration and never spawns a child process.

Rex is the terminal multiplexer the user runs pi inside. It gained **floating panes**
(Rex v0.1.0-preview.22): a pane can be lifted out of a tab's layout into its own layer above
it. A floating pane can be **minimized** into a capsule at the bottom of the window, which
makes the set of minimized panes a compact, always-visible inventory of what is running.

The user wants subagents to live in those panes: each subagent runs as a **real `pi`
process** in its own floating pane, minimized the moment it is created, so that glancing at
the window shows what is running, opening a pane shows what that agent is doing, and either
the user or the orchestrator can steer it mid-run. When the agent finishes, its `pi` exits
and the pane disappears; `/agents` remains the record of finished agents and their chat logs.

## Goal

Inside Rex, a subagent is a real `pi` session in a minimized floating pane, observable and
steerable from both ends, with the parent's `/agents` and tool surface behaving as they do
today. Outside Rex, nothing changes.

## Decisions (from brainstorming)

The user's decisions, in their words where it matters:

1. **Every spawn gets a pane** — top-level `Agent`, nested children, and workflow fan-outs
   (20 at once included). No exceptions for depth or size.
2. **A real `pi` per subagent**, not a mirror of an in-process agent: the thing in the pane
   is the session you would get if you had opened that pane and typed the task yourself.
3. **Minimized immediately** after creation, so the visible result is a row of capsules.
4. **Glance, open, steer**: at a glance it shows the agent is running; open it and you see
   what it is working on; either the user (typing) or the orchestrator (`steer_subagent`,
   `@handle`) can steer it mid-run.
5. **The child session ends when the agent finishes**, and the pane goes away with it.
6. **`/agents` stays the record**: finished agents are still listed and their chat log is
   still reviewable, exactly as today.
7. **Auto-detect, no mode switch**: the pane path inside Rex, the current in-process path
   outside it.

My calls, stated in brainstorming and unchallenged:

8. Results, transcripts, and usage are read back from the child's **own pi session file**,
   which is what keeps the widget, `get_subagent_result`, the viewer, and `/agents` honest.
9. Pane labels carry the agent's handle plus a short slice of its task description.
10. When Rex stops answering mid-run, the agent keeps running in its pane and the parent
    says so rather than pretending the agent vanished.
11. A full `pi` process per agent is an accepted cost — its token usage is read back into
    the parent's stats so the numbers do not lie.
12. An agent type's restriction on extensions and skills must still bind inside its pane, even
    though the child is a normal `pi` (asked and answered during the builder check, after
    checking that Superpowers' own agent templates rely only on `tools`, `allowed_subagents`,
    `thinking` and `max_turns`): confinement is enforced through CLI flags rather than left
    advisory.

## Constraints, and what Rex actually offers

Verified against the running server (Rex CLI `0.0.1793420730-g6d0d9a`, app `0.1.0 (1747)`):

| Need | Mechanism | Status |
|---|---|---|
| Create a pane running a program | `session.new_layer` with a `com.superlogical.terminal.shell` block, `options: { command: [...], cwd, exit: { on_completion: true } }`. **No `shell` key**: with the default `login: true`, `"shell": "none"` runs the command under `/usr/bin/login` and reports `exit_code: 0` for every outcome, while omitting it keeps argv verbatim and reports the real status | works from the CLI/API |
| Pane disappears when the program exits | terminal block `exit.on_completion` (default `true`). Measured later: a failing `pi` closes its own pane within a second or two, so a run may never depend on a pane that survived the exit | works |
| Pane label | `label` on the block in the layout | works |
| Minimize a pane | `session.set_layer_state { state: "minimized" }` — server-side, no app client involved; `state` then appears in `session.view`, the layer keeps running and keeps its bounds | works, verified |
| Live "is it working" indicator | pi already emits OSC 7501 program status; Rex surfaces it per pane | works, for free |
| Program exit status / still running | `rex block call -b BLOCK process` (`last_exit`) | works |
| Close a pane | `session.close_layer` / `block.close` | works |

Findings from the probe that shape the mechanics:

- **Minimize is one server call, not an app interaction.** The earlier build exposed it only as the
  client action `pane.minimize_floating`, which answered `not_supported` to every headless
  attempt; current Rex adds `session.set_layer_state`. Creating a floating layer and then
  setting it to `minimized` was verified end to end, and `session.view` reports the layer's
  `state`. No focus change, no app client, no queue of app actions.
- **`session.new_layer` still has no `state` option**, so minimization is a second call. A pane
  can therefore be on screen for the few milliseconds between the two, and Rex's open feature
  request ("Add an API option to create floating panes already minimized") is exactly about
  that gap. When it lands we pass `state: "minimized"` at creation and delete the second call.
- **A floating layer can only be minimized while its window keeps a visible pane.** Our panes
  are floating layers above a tiled one, so this holds; the failure mode is worth handling
  anyway because it is a `bad_request`, not a crash.

## Architecture

One idea: **the manager stops owning the run loop and owns the record; the pane owns the
run**. `AgentManager` keeps every behaviour it has today — handles, statuses, pools, queue,
tombstones, settle, notifications, `/agents`, RPC, schedules — and a *run* becomes an
injectable strategy with two implementations: the current in-process `runAgent()`, and a
new pane-backed one.

### 1. The seam: `RunHandle`

`runAgent()`/`resumeAgent()` are the only two functions that create a session and prompt it,
called from exactly three places (`src/agent-manager.ts:763`, `1179`, `1273`). Downstream
code consumes a narrow contract — the six existing `on*` callbacks plus a session-shaped
object that only needs:

```
steer(msg)            abort()             messages (length + read)
getSessionStats()     sessionFile         model, thinkingLevel
dispose()             extensionRunner.hasHandlers/emit
```

Introduce `RunHandle` for exactly those operations and a `Runner` with `start()`/`resume()`,
constructed in the manager's constructor. `AgentRecord.session?: AgentSession` becomes
`record.session?: RunHandle` — the field keeps its name, which is why every reader that already
gated on `record.session` (FleetView, the viewer, `/agents`, the result tools, the output
transcript) needed no change beyond the type. The call sites are more numerous than
the name change suggests, and each is a place the plan must cover: the widget activity tracker
(`index.ts:157`, `agent-widget.ts:459`), fleet list (`fleet-list.ts:249,402`), viewer
(`conversation-viewer.ts:196,513`), `get_subagent_result` (`index.ts:3198,3229`), the
`streamToOutputFile` wiring (`index.ts:1382-1404`, `2118`, `2326`), mention resume
(`index.ts:1023`), the in-process `steer_subagent` body (`index.ts:3278-3290`), View log
(`index.ts:3494`), `nested-tools.ts`, and `usage.ts:151-167`.

This keeps `/agents`, the widget, mentions, RPC, group-join, schedules and workflows working
without redesign, and it is the smallest seam that admits a second execution model.

### 2. Detection: which modality

`src/rex/detect.ts`, a cached probe evaluated once per process:

- `REX_SESSION` and `REX_BLOCK` present, and
- the parent's stdout is a terminal (`process.stdout.isTTY`) — a print-mode or
  RPC-driven parent has nobody watching capsules and may exit mid-run, so it keeps the
  in-process runner, and
- `rex whoami --json` succeeds (exit 0, parseable), and
- not already in child mode (see §4).

### 3. Parent side: the pane launcher

`src/rex/launcher.ts` — pure builders plus thin `rex` invocations, so the command shapes are
unit-testable without a Rex server:

1. **Compose the child's inputs** into `<taskdir>/<agentId>/`: `system.md` (the agent-type
   system prompt, memory and read-only memory blocks, parent context — the same composition
   `buildAgentPrompt()` does today, without the session-bound parts), `prompt.md` (the task),
   `spec.json` (see §4). `taskdir` reuses `sessionTaskDir()` from `src/output-file.ts`.
2. **Create the pane**: `rex api call session.new_layer` with bounds derived from the
   parent's window and the index of this pane in the current stack, layout block
   `com.superlogical.terminal.shell` with
   `options: { command: [...], cwd, exit: { on_completion: true } }` — **no `shell` key**, for the
   reason measured in the constraints table above — `label: "<handle> · <description, truncated>"`,
   `focus: false`.
   The command begins with `env` so the child can be told which subagent it is — a terminal
   block's options have no `env` field (`additionalProperties: false` on
   `com.superlogical.terminal.shell`), so the variable rides in the command:
   `["/usr/bin/env", "PI_SUBAGENTS_CHILD_SPEC=" + specPath, piBinary, ...]`. The child deletes
   that variable after reading it (§4), so anything it starts itself cannot inherit the wrong
   spec.
   The rest of the command is `[piBinary, "--session-id", childSessionId, "--session-dir",
   agentSessionDir, "--name", childSessionId, "-a" | "-na", <systemPromptFlag>, systemFile,
   ...confinementFlags, "--provider", provider, "--model", modelId, ...thinkingFlags,
   "@" + promptFile]`, with the working directory set by the block's `cwd`;
   `piBinary` is the parent's own executable (`process.execPath`) so the child is the same build
   and needs no `pi` on `PATH`; the trust flag is `-a` when the parent session trusts the
   project and `-na` when it does not, so a child never stops on a trust prompt in a pane nobody is
   reading; `--provider`/`--model` are always explicit because `-ne` (or an allowlist that omits
   the provider's extension) makes `--provider` unresolvable; and `<systemPromptFlag>` is
   `--system-prompt` when the agent type's `prompt_mode` is `replace` (the shipped `Explore` and
   `Plan` types, and any agent file that omits it) and `--append-system-prompt` when it is
   `append`. A resume swaps the two session flags for `--session <sessionFile>`.
   `agentSessionDir` is a dedicated store, `<agentDir>/subagent-sessions/<rootSessionId>/`, so a
   fan-out does not fill the user's `/resume` picker while transcripts still outlive the pane.
   `confinementFlags` is where an agent type's restrictions are reproduced, and it must match
   `runAgent()`'s semantics (`agent-runner.ts:719-724`, `775-860`) or the pane child is a
   different, less confined agent:
   - `isolated: true` → `-ne -ns -nc --no-mcp` (built-ins only, no extensions, skills or
     context files), which is what `isolated` already means in-process;
   - `extensions: false` → `-ne`; `extensions: true` → nothing;
   - `extensions: [names, paths, "*"]` → `-ne` plus `-e <resolved path>` for each survivor,
     resolving names exactly as `parseExtensionsSpec()` does, **plus** `-e builtin:codemode`
     (and `builtin:tool-search`, hyphenated as pi names it, when it is active), because the
     in-process path always loads
     codemode through an inline factory (`agent-runner.ts:849`, Divergence 4) — dropping it
     from an allowlisted child would silently remove a tool its in-process sibling had;
   - `exclude_extensions: [...]` → resolved the same way and subtracted from the include set
     before the `-e` list is built, exclude-wins, as the in-process override does;
   - `skills: false` → `-ns`; `skills: [a, b]` → `-ns --skill <path>` per skill. The in-process
     path preloads the text into the prompt; the pane child loads them as skills. Same
     available knowledge, different carrier — stated in the docs rather than papered over;
   - `config_cwd` → no CLI equivalent. It rides in the spec, and child mode logs a warning
     naming the agent and the value once per spawn.
3. **Minimize**: `session.set_layer_state { layer_id, state: "minimized" }` on the layer just
   created. Server-side and synchronous; no focus change, no app client, no coordination with
   the user's keyboard. A failure here is logged and reported but does not fail the spawn — the
   agent is already running.
4. **Watch**: a `PaneRun` (§5).
5. **Clean up**: on settle, if the pane still exists, close the layer.

What the parent must *never* do: leave a pane with no record, or claim a pane was minimized
when the call failed.

### 4. Child side: spec file and child mode

The child needs to know it is a subagent, apply the subagent's remaining configuration, report
its result in a form the parent can read cheaply, and end itself.

- **Spec file**, path in `PI_SUBAGENTS_CHILD_SPEC`:
  `{ agentId, rootSessionId, parentAgentId, depth, maxSubagentDepth, allowedSubagents,
     resultPath, cwd, maxTurns, graceTurns, structuredSchemaPath?, toolScope: { tools,
     excludeTools }, pane: { sessionId, layerId, blockId }, model, thinking }`.
- **Child mode** — `index.ts` reads the variable at startup, deletes it from `process.env` so
  nothing it launches can inherit it, and, when present, takes a narrow branch: no root-manager
  registration, no scheduler, no widget, no `/agents`, no completion nudges, no status note, no
  pane for itself. It keeps:
  - the nested-style `Agent` / `get_subagent_result` / `steer_subagent` tools — but only when the
    agent type opts in through `allowed_subagents`, exactly as `nested-tools.ts` gates them today
    (`agent-runner.ts:955-962`), and never when `isolated`; the spec carries the resolved type
    config so the child does not have to rediscover it;
  - the depth cap: the spec carries `depth` and `maxSubagentDepth` (counted from the main
    session, main = 0, as `settings.ts:240-245` documents), so a fresh process cannot reset
    recursion — at the cap the `Agent` tool is not registered at all;
  - agent-type tool scope enforcement (the `toolScopeVeto` helper and `pi.setActiveTools`,
    the extension-API equivalent of `installExtensionToolScope`);
  - max-turns soft/hard limits (`steer` / `abort` on the child's own run), the
    `StructuredOutput` tool and its retry prompt when a schema is present.
- **Result file** `<taskdir>/<agentId>.result.json`, written on `agent_settled` (and on abort
  or fatal error), holding `{ text, failure, aborted, steered, structuredJson,
  structuredRetried, usage, model, thinkingLevel, sessionFile, turns }`. Written before the
  shutdown, atomically (write temp, rename).
- **Self-termination**: on `agent_settled`, after writing the result, `ctx.shutdown()`. That
  is what makes "the real pi session ends when the subagent is done" true, and it is what
  makes the pane close itself via `exit.on_completion`.

Prompt and model decisions stay in the parent (§3) so the child stays thin: the same
`buildAgentPrompt()` composition, the same model resolution, the same worktree-aware prompt,
just delivered as files and flags.
### 5. Parent side: `PaneRun`

`src/rex/pane-run.ts` implements `RunHandle` for one agent:

- **Completion**: await the result file — polled every 100 ms, because the file appears by
  rename and there is nothing to watch before it exists — or the process exit, whichever comes
  first. The exit comes from `rex wait -s <session> <block> --json --for <ms>` (the block is an
  argument, not a flag), whose `child_exited` payload carries the code as `exit_code`, with
  `rex block call -s <session> -b BLOCK process` → `last_exit` as the fallback. A child that
  exits without a result file is reported with the exit status and whatever the session tail
  holds plus `rex capture -s <session> -b BLOCK --trim` when the pane still exists. `{ lastExit:
  null, status: null }` means "not yet observable", never "still running", because it is what
  both a closed block and a live program read as.
- **Blocked child**: a child that stops on its own prompt (permission, question, login) is
  reported the way Rex reports it — `program_status` says `blocked` — and the run keeps waiting
  for as long as any agent run waits today. There is no timeout and no auto-abort: the human can
  answer the prompt in the pane, and the parent's record says the agent is waiting, not working.
- **Live state**: tail the child's session JSONL in `agentSessionDir` (§3), found by
  `childSessionId`, to derive `messages`, turn count, tool activity, usage,
  `getSessionStats()`, and to feed `onToolActivity` / `onTextDelta` / `onTurnEnd` /
  `onAssistantUsage` / `onCompaction` into the existing activity tracker. Message objects are
  kept stable across appends (the viewer's Markdown cache is keyed by object identity).
- **Pane state**: `session.view` reports each floating layer's `state`, so a run *could* know
  whether its pane is still minimized, was opened by the user, or is already gone. v1 does not
  poll it: nothing a run decides depends on the layer's state, and a pane that is gone is
  visible as a block call that answers `not found`.
- **Proxy session**: a `PaneSession` implementing the `RunHandle` subset the UIs touch
  (`messages`, `subscribe`, `getSessionStats`, `sessionFile`, and the injected steer/abort), so
  `fleet-list.ts:249`, `conversation-viewer.ts:196,513`, `index.ts:3198`, and `usage.ts` keep
  working unchanged. It deliberately reports no `model`, `thinkingLevel` or `extensionRunner`:
  the record's invocation snapshot carries the labels, a child's extensions live in the child
  process, and a handle has to be honest about what a file can tell it. The `subscribe` surface
  must also carry the `turn_end` / `compaction_start` / `compaction_end` events
  `streamToOutputFile()` listens for (`output-file.ts:100-155`), so `.output` transcripts keep
  being written from the tail and `record.outputCleanup` keeps its meaning.
- **Steer**: `rex send -s <session> -b BLOCK <text>` then `rex send-key -s <session> -b BLOCK enter`,
  refused unless the pane's program status says the child is running or idle (never typed into a
  dialog).
- **Abort**: close the block (`session.close_layer`) — the child dies, status `"stopped"`;
  an aborted child that wrote a result file is `"aborted"`.
- **dispose**: on parent `session_shutdown`, close any panes this session created and is
  still watching.

### 6. What each surface reads afterwards

| Surface | Today | With panes |
|---|---|---|
| Live widget | `AgentRecord` + `agentActivity` | unchanged; activity fed by the JSONL tail |
| FleetView rows | `record.session` truthiness gate | unchanged: `record.session` is the `PaneSession` proxy |
| Conversation viewer | `session.messages` + `session.subscribe` | same calls, on the proxy |
| `get_subagent_result` | `record.promise` → `record.result` | unchanged; `record.result` comes from the result file |
| `get_subagent_result({verbose:true})` | `getAgentConversation(record.session)` | proxy `messages` mapped to the same transcript text |
| `/agents` → View log | overlay on `record.session` | overlay on the proxy — a finished agent's log still opens, because the child's session file outlives the pane |
| Context % | `getSessionStats()` | **absent**: the tail reports token totals but no `contextUsage`, because a percentage needs the model's context window and the session file does not name it. Absent rather than wrong, which the widget already tolerates |

### 7. Lifecycle and failure matrix

| Condition | Behaviour |
|---|---|
| Not inside Rex (no env vars, or `rex` missing/unreachable) | in-process runner, today's path |
| `runInRexPanes: "off"` | in-process runner |
| `session.new_layer` fails | that agent runs in-process; the record carries `paneFallback`, which `getModalityNote()` renders as `(ran in-process: could not get a pane (creating it failed))`, and a warning is raised at the same moment |
| Minimize call fails (`bad_request`, e.g. the window would lose its last visible pane) | agent unaffected; the pane stays visible and the fallback is reported, not hidden |
| Child exits with no result file | status `error`, message built from exit code and the captured pane tail |
| User closes the pane | status `error` with no result file: closing the layer kills the child, and a hand-closed pane is indistinguishable from a failing one |
| Rex unreachable mid-run | the run continues; completion is detected from the result file; the warning says the pane could not be watched |
| Parent not interactive (`pi -p`, RPC/SDK parent) | in-process runner: nobody is watching capsules and the parent may exit mid-run |
| Parent session shuts down | panes for running agents are closed, best effort, including one created before the record had a handle; a layer that will not close is reported, because its child may still be running |
| Queued agent (pool full) | the pane is created when the run actually starts, as the session is created at that point today |
| Quick failure (child dies in <250 ms) | measured: the pane closes with the child — a failing `pi` exits and `exit.on_completion` takes the pane with it. Completion and failure are read from the result file and the exit status, never from a surviving pane |

## Consequences that change today's behaviour

These are accepted, not accidental, and belong in the README:

1. **Grandchildren are not in the parent's `/agents`.** Today nested spawns share one
   manager, so a grandchild appears in the top-level list. In the pane path the child process
   has its own manager: its children are visible as panes, in the child's own `/agents`, and
   nowhere else. Aggregating them is a possible follow-up, not v1.
2. **Concurrency pools are per process.** `maxConcurrent` still bounds one manager's children;
   a fleet of 20 grandchildren is bounded by the parent's pool plus each child's. The depth cap
   does *not* reset, because the spec carries `depth` and `maxSubagentDepth` across the boundary.
3. **Startup cost per agent.** Each subagent pays a real pi start (binary, extensions, MCP
   connections). Fan-outs will feel slower to first token than the in-process path.
4. **Usage arrives at settle, or a turn behind.** Token and cost totals are read back from the
   child's session file rather than streamed per message.
5. **Transcript fidelity is a mapping.** The viewer renders pi's session entries (including
   `compaction`, `branch_summary`, `custom_message`) through a new mapper; anything the mapper
   does not understand is skipped deliberately, not silently rendered wrong.
6. **A subagent can now be interacted with by the user.** Steering a pane by hand is
   supported and intended; the parent's record reflects the resulting extra turns.
7. **Agent-type confinement binds, with one exception and two changed carriers.** Everything an
   agent file can restrict — `tools`, `disallowed_tools`, `isolated`, `extensions`,
   `exclude_extensions`, `skills`, `allowed_subagents`, `thinking`, `max_turns`, `prompt_mode` —
   is honoured in a pane child, through flags (§3). Two things are carried differently: an
   allowlisted set of extensions is passed by resolved path rather than filtered inside a shared
   loader, and `skills: [a, b]` loads those skills instead of preloading their text into the
   prompt. The exception is `config_cwd`, which has no equivalent: the child discovers project
   config from its own working directory, and child mode warns when a type sets it. One
   consequence of expressing confinement as flags rather than as a loader filter: **provider
   extensions are extensions.** `-ne`, or an allowlist that omits the model's provider extension,
   makes `--provider <name>` unresolvable inside the child: pi prints `Unknown provider "<name>"`
   and exits 1 before writing a result file, so the run reports an exit-without-result error
   instead of falling back to another model. That is why `--provider`/`--model` are always passed
   explicitly, and why restricting extensions on a type whose model needs an extension means
   either keeping that extension in the allowlist or accepting that the type cannot run in a
   pane. A third thing is not confinement at all but reads like it: the child's transcript
   always goes to the session store, so `persist_session` and `session_dir` do not move it. The
   agent-file documentation must say all of it.
8. **Subagent sessions leave the user's `/resume` list.** They live under
   `<agentDir>/subagent-sessions/<rootSessionId>/`, so transcripts survive the pane and `/agents`
   can reopen them, without a fan-out filling the session picker.

## Deliberately not doing

- No dependency on Rex adding `state: "minimized"` to `session.new_layer`; if it lands we pass it at
  creation and delete the follow-up `set_layer_state` call.
- No `pi --mode rpc` child. The pane must show a real session that a human can type into;
  RPC mode spends the terminal on a protocol.
- No in-pane UI of our own (badges, status lines). Raciness belongs to Rex; the pane shows a
  plain `pi`.
- No reuse or pooling of panes, no "hidden agent" mode, no cap on simultaneous panes.
- No change to mention clones or the workflow worker thread — neither is a subagent run.
- No persistence of the pane's block id across sessions; after the parent restarts, a running
  orphan is the user's to close.

## Verification

Code changes run the package gate: `cd packages/pi-subagents && npm run check`
(lint + typecheck + tests). Root `npm test` runs every package's gate.

New coverage:

- **Unit** — launcher argument/spec builders (command array, bounds, label, tool/model
  flags, and the confinement matrix: `isolated`, `extensions: false|true|[names]|["*"]`,
  `exclude_extensions`, `skills: false|[a,b]`, `prompt_mode` replace/append) with no Rex at
  all, asserted against the in-process fixtures the package already has for those agent files
  (`test/fixtures/.pi/agents/*`); child-mode spec parsing and result-file writing; JSONL tail
  mapper over captured session fixtures (text, toolCall, toolResult, compaction); fallback
  matrix in `detect.ts` with a stubbed `REX_*` environment.
- **Integration** — a fake `rex` executable placed on `PATH` (records calls, simulates
  `new_layer` / `set_layer_state` / `block call process` / `session.close_layer`) plus a stub child
  that writes a session JSONL and a result file. Asserts the full record lifecycle through the
  pane path: record reaches `completed`, `record.result` matches the result file, a proxy
  session answers the widget/fleet/viewer reads, `steer` and `abort` emit the expected Rex
  commands, and the pane is closed on settle.
- **Manual smoke test** (the `smoke-test-approved` step) on real Rex with a real `pi`:
  1. One foreground `Agent` call → one capsule appears minimized, opens on demand, shows the
     child's session, and disappears on completion while `/agents` still lists it and opens
     its log.
  2. A background agent steered from the parent with `steer_subagent` → the message arrives
     in the pane and the agent acts on it.
  3. A 3-way fan-out → three capsules, all minimized, correct labels.
  4. A nested spawn (child spawns a child) → a fourth capsule, child's result reaches its
     parent.
  5. Kill an agent from `/agents` → pane goes away, status `stopped`.
  6. Outside Rex (plain terminal) → in-process path, no panes, widget identical.

## Risks, in retirement order

1. **The pane is briefly visible.** `new_layer` and `set_layer_state` are two calls, so a pane
   can paint before it is minimized. Retirement: measure the gap (it is two CLI round trips); if
   the flash is noticeable, batch both calls in one `rex` Lua script (`rex do -`) so the app sees
   one revision per create-and-minimize. Adopt `state: "minimized"` on `new_layer` when Rex ships
   it.
2. **The child does not exit on settle.** `ctx.shutdown()` from an `agent_settled` handler is
   the claim; verify also for aborted runs, and for a child that stops on a UI prompt (where
   it should *not* exit — the user may answer it).
3. **Prompt/system-prompt delivery.** `--append-system-prompt <path>` and `@path` are the
   documented file forms; confirm that a large `@path` prompt produces the same first message
   shape the in-process path produces, and that argv stays small.
4. **Steering by typing.** `rex send` + `send-key enter` lands in whatever the TUI is showing.
   Gate on program status; verify with a mid-run steer and with a child sitting at a dialog.
5. **Process cost at fan-out.** Measure 20 concurrent children (time to first token, RSS). If
   it is unusable, the honest response is a documented cap, not a silent queue change.
6. **Confinement parity drift.** The flag mapping is a second implementation of a rule that
   lives in `agent-runner.ts`, and the two can disagree — codemode in an allowlisted child is the
   first case. Retirement: drive the mapping tests from the same fixture agent files the
   in-process tests use, so a divergence shows up as a failing test rather than as a quietly
   less-confined agent.
7. **Transcript mapping fidelity** — compaction and branch entries in the viewer.
8. **Trust.** The child must not stop on a project-trust prompt in a pane: pass `-a` when the
   parent session trusts the project, `-na` when it does not.

## Implementation order

1. **Spike** (throwaway script, no product code): verify `ctx.shutdown()` from `agent_settled`
   closes a real pane, when a child exits on its own versus when it stops on a UI prompt, and how
   long the create→minimize flash lasts. Minimize itself is already verified.
2. `src/rex/detect.ts` + the `runInRexPanes` setting, with tests.
3. `src/rex/launcher.ts` builders (spec, files, command array, bounds) + the confinement
   mapping of §3 — the task where a wrong guess quietly weakens an agent type — with tests.
4. Child mode in `index.ts`: spec parsing, tool scope, result file, self-shutdown + tests.
5. `src/rex/pane-run.ts` + JSONL tail + `PaneSession` proxy + tests.
6. `RunHandle` seam in `agent-manager.ts`/`types.ts`, both runners wired, fallback matrix.
7. UI adoption of the `RunHandle` contract on `record.session` (fleet list, viewer, `/agents`,
   `get_subagent_result`).
8. Docs: README (features, settings, behaviour table), new `docs/rex-panes.md`,
   `docs/rpc.md` note, `CHANGELOG.md`, and a divergence entry in
   `docs/pi-subagents-local-patch.md`.
9. Gate + manual smoke test.

## Out of scope

- Rex-side changes (a `state: "minimized"` option on `session.new_layer`, or anything else the
  Rex maintainers own).
- Aggregating grandchildren into the parent's `/agents`.
- Pane reuse, agent-to-agent panes, attach/detach of a running agent between panes.
- Remote-host Rex, Windows, and non-macOS servers beyond what the CLI already abstracts.
- Any change to the in-process path's behaviour when it is the one in use.
