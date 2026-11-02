# Running subagents in Rex panes

This guide is for anyone whose subagents run inside [Rex](https://superlogical.com/rex) and who wants to know what a capsule at the bottom of the window is, why one did not appear, or what an agent file can still confine in a child. [`README.md`](../README.md#rex-panes) has the one-table summary and the setting; this is the long form, and it is written against the code in `src/rex/` — where it and the code disagree, the code wins.

Inside Rex, a subagent is a **real `pi` process in a minimized floating pane** rather than an in-process SDK session. Creating one is a `rex` call, watching it is a file and a process status, steering it is typed input, and stopping it is closing a layer. The parent keeps every surface it had: `/agents`, the widget, FleetView, the conversation viewer, `@handle`, `get_subagent_result`, workflows, schedules. It reads them through a proxy instead of a live session — that is the whole design, and most of what follows is a consequence of it.

## What a pane subagent is, and is not

It **is** the session you would get if you had opened a pane and typed the task into `pi` yourself. Same binary as the parent (`process.execPath`), same provider and model, same thinking level, same confined tool set, the same project trust decision (see the trust flag below), and the same system prompt the in-process runner would have built.

It is **not**:

- a mirror of an in-process agent — there is no shared session, so anything the parent knows about the child it learned from a file;
- a second manager inside the parent's process — the child is a separate `pi`, with its own manager for its own children;
- available outside Rex. Detection needs `REX_SESSION`, `REX_BLOCK`, a terminal on stdout, a `rex` CLI that answers `whoami --json`, and no child-spec marker in the environment. A `pi -p` or RPC-driven parent has no terminal and keeps the in-process path: nobody is watching capsules, and the parent may exit mid-run.
- the only modality. `runInRexPanes: "off"` (or `/agents → Settings → Rex panes`) always uses the in-process runner, which is what the rest of this package's documentation describes.

The modality is decided once per pi process, at its first agent spawn, and cached — including a failure. A change made before that first spawn applies at once; after one, it takes a restart.

## The pane contract

One pane per spawn, created in the parent's own Rex session and window, never in anyone else's.

| Element | What it is |
|---|---|
| Label | `<handle> · <description>`, truncated to 60 characters of description with a trailing `…`. The handle is what `@`, `steer_subagent` and `resume` accept — `explore-2` for a second Explore, or the agent type when a record has no handle (nested children) |
| Layout | A floating layer above the parent's tiled one, `focus: false`, so it never steals the keyboard. Bounds cascade in a right-hand column: six lanes, each a little lower and further right, then the column repeats — by then the earlier panes are minimized and overlap costs nothing |
| Command | `<pi> --session-id <agent id> --session-dir <store> --name <handle> <trust flag> <system-prompt flag> <system file> <confinement flags> --provider <p> --model <m> [--thinking <level>] @<prompt file>`, run verbatim in the block's `cwd`. argv stays a few hundred bytes however large the task or system prompt is. The session id is the durable agent id — it is what finds the transcript the parent tails — while `--name` is the handle, so the pane's own session is named the way the user reaches it |
| Environment | `PI_SUBAGENTS_CHILD_SPEC=<spec file>` rides in the argv, because a terminal block's options have no `env` field. The child deletes the variable once read, so nothing it starts can inherit the wrong spec |
| `shell` | Deliberately **absent**. Measured on Rex `0.0.1793420730`: `"shell": "none"` with the default `login: true` runs the command under `/usr/bin/login`, which then reports `exit_code: 0` for every outcome. Leaving the key out keeps argv verbatim and reports the real status, which is what tells a crash from a clean exit |
| Minimize | A second call, `session.set_layer_state { state: "minimized" }`, made immediately after creation — the pane can be on screen for the 21–29 ms between the two. Create and minimize are serialized in one queue, so a fan-out does not flicker twenty panes on screen in whatever order the server answers |
| Exit | `exit.on_completion` (Rex's default) closes the pane when the child exits. A failing `pi` therefore closes its own pane within a second or two: the run never depends on a surviving pane, and a pane still on screen is not evidence that a run is still alive |
| Program status | pi emits OSC 7501 program status, which Rex surfaces per pane, so `working` / `idle` / `blocked` is there for free. That state is how the parent tells a working child from one sitting at a prompt |
| Result | The child writes `<task dir>/<agent id>.result.json` before shutting itself down — atomically, by rename, so a reader never sees half a result |

### The trust flag

`-a` or `-na` answers the question pi would otherwise ask a human — "do you trust this project?" — and a pane has nobody to ask. `-a` is passed only when the parent session trusts its own project *and* the child works in it (a worktree spawn counts: it is the parent's own copy), because the flag trusts the project-local `.pi` files of the directory the child starts in. A spawn whose `cwd` is some other repo gets `-na`, so that repo's `.pi` files are not trusted on the parent's behalf; that child sees what an untrusted session sees, which confines it more rather than less.

## How a run settles

The parent watches two things at once and takes whichever finishes first:

1. **The result file**, polled every 100 ms. A child that writes it has answered: `text`, `failure`, `aborted`, `steered`, `structuredJson` and `structuredRetried` all come from it, and a `failure` makes the run an error rather than a completion.
2. **The child's exit**, from `rex wait -s <session> <block> --json --for 30000ms` in 30-second windows (two round trips a minute per agent, and a server restart still gets noticed), with a 500 ms `block call … process` poll as the fallback when `wait` says nothing.

A child that exits **without** a result file ends the run as an `error`, and the message carries what is knowable: the exit status (`an exit status that could not be observed (the pane closed first)` when the pane went with it), the child's last assistant message from its session file, and the pane's last lines when the pane still exists. Nothing waits on a pane: by the time a crash is visible, the screen is usually gone already.

`{ lastExit: null, status: null }` means **not yet observable**, never "still running" — it is what both a closed block and a program that has not exited read as, so the exit is taken from `wait` and the process read is only ever the fallback.

Closing a pane by hand is the same event as a crash: the child dies, no result file is written, and the run ends as an error. A hand-closed pane and a failing child are indistinguishable from the parent's side, and the record says so rather than claiming `stopped`.

## Steering and stopping

**From the parent**, `steer_subagent` (or `@handle <message>`) types the message into the pane and presses Enter. It is refused — with the reason in the tool result — unless the child's program status is `working` or `idle`:

| Child state | What `steer_subagent` answers |
|---|---|
| `working`, `idle`, or no status yet (a just-started `pi` reports nothing for a few hundred milliseconds, and that window is waited out) | The message is sent |
| Still no status after about two seconds | `agent "…" is not answering in its pane; the message was not sent` — a child that never reports is one this runner cannot reach, and the wait is bounded rather than open |
| `blocked` — at a permission, question or login prompt | `agent "…" is waiting on a prompt in its pane — answer it in the pane, or abort the agent; the message was not sent` |
| `done`, `error`, or a state this build has never seen | Refused; a whitelist, not a blacklist of `blocked` |
| Already exited | `agent "…" has already exited; the message was not sent` |

Two refusals come after the state gate has already said yes, from the transport itself: `the steering message could not be typed into the pane: …` when the `rex send` that carries the text fails, and `the steering message was typed but not submitted: …` when the text landed but the Enter that submits it did not — in the second case the message is sitting on the child's prompt, unsubmitted, and the child has not seen it.

A refused steer is never silently dropped: `steer_subagent` reports it in its own result, and a steer queued before the session existed is reported as a warning — `the steering message for agent "…" was not delivered: …` — rather than counted as delivered.

The message is typed as one line: a message carrying a newline or any other control character is refused rather than sent, because a pane submits on every newline and the Enter that finishes the steer would submit a second, empty prompt. It is also passed after `--`, so a message that begins with `-` is text rather than a flag for `rex send`.

**From the pane**, you are typing into a normal `pi` session: any prompt, any slash command. Extra turns you cause are counted and reported like any others.

**Stopping** always closes the layer, which kills the child. `x` in `/agents`, `Esc` on a blocking foreground call, and a parent that aborts for any other reason all reach that same close, and all leave the record `stopped` — the abort marks it stopped before the run can report anything of its own. `aborted` is a different status: it means the run ran out of turn budget, and on this path only the child's own self-stop can produce it. There is deliberately no way to interrupt a single tool call: a pane run is stopped, not paused.

**Resuming** relaunches the child on its own session file (`--session <file>`) in a fresh pane. It is the same conversation continued under a second process, which is why a pane agent stays resumable after its pane is gone — `Agent({ resume })` and `@handle` work exactly as they do in-process.

**Structured output** works the same way: for `agent({ schema })` — and for a workflow step that passes a schema — the parent writes the caller's schema beside the child's prompt, the child recompiles it with the same validator and answers through its `StructuredOutput` tool, and the validated payload comes back in the result file's `structuredJson`. A schema the parent cannot hand over at all (an unusable task directory, a file it cannot write) sends that run **in-process** with the reason on the record (`ran in-process: could not be handed its structured-output schema (…)`) rather than launching a child without the tool, and a child that still cannot apply the file reports the problem as the run's `failure` instead of quietly answering in prose.

## What an agent file can confine in a pane

Confinement is reproduced as `pi` flags, because the child is a normal `pi` and nothing else can narrow it. The mapping mirrors the in-process runner, and the tests drive it from the same fixture agent files the in-process tests use.

| Frontmatter | In a pane child |
|---|---|
| `isolated: true` | `-ne -ns -nc --no-mcp` — no extensions, skills, context files or MCP; `allowed_subagents` is forced off and `ext:` selectors are dropped |
| `extensions: false` | `-ne` |
| `extensions: true` | Nothing: the child discovers the same extensions the parent did |
| `extensions: [names, paths, "*"]` | `-ne` plus one `-e <resolved path>` per survivor, plus `-e builtin:codemode` (and `-e builtin:tool-search`) when the parent had those built-ins active |
| `exclude_extensions: [...]` | Resolved the same way and subtracted from the include set first — exclude wins |
| `skills: false` | `-ns` |
| `skills: [a, b]` | `-ns --skill <path>` for each named skill. The in-process path preloads their *text* instead; same knowledge, different carrier |
| `tools`, `disallowed_tools`, `ext:` selectors | The parent resolves them into the spec; the child re-applies them to its own tool set at `session_start` and every `turn_end` (`setActiveTools`), plus a `tool_call` veto, because a script reaches `codemode`/`deferred` tools whether or not they are active |
| `model`, `thinking` | `--provider`/`--model` always explicit, `--thinking` when a level was set. Nothing is inferred from the environment — see the provider note below |
| `max_turns`, grace turns | The caller's or the type's cap rides in the spec; the project's `defaultMaxTurns` / `graceTurns` are read by the child itself from its own settings, so a pane child and an in-process one wrap up at the same turn |
| `allowed_subagents` | The child registers the nested `Agent` / `get_subagent_result` / `steer_subagent` tools when the type opts in and it is below the depth cap. The cap crosses the process boundary, so a fresh `pi` cannot reset recursion |
| `prompt_mode` | `replace` → `--system-prompt <file>`; `append` → `--append-system-prompt <file>` |
| `memory` | Composed into the prompt (a file the agent is told about), read-only when the agent has no write tools |
| `isolation: worktree` | The worktree is created by the parent before the run, and the pane's `cwd` is that worktree, so opening the capsule puts you in the tree the agent is actually editing |
| `enabled`, `description`, `display_name`, `color`, `run_in_background`, `inherit_context` | Unchanged — dispatch and display, not the child's process |

**`config_cwd` is the one key with no pane equivalent.** A child discovers project config (agents, settings, skills) from its own working directory, and a terminal block can set a `cwd` but no second config root. Child mode logs one warning per spawn naming both paths:

```text
[pi-subagents] agent "<id>" sets config_cwd <path>, which a pane child cannot reproduce:
it reads project config from its own working directory (<cwd>)
```

**Provider extensions are extensions.** `-ne`, or an allowlist that omits the model's provider extension, makes `--provider <name>` unresolvable inside the child — a startup failure, not a fallback: pi prints `Unknown provider "<name>". Use --list-models to see available providers/models.` and exits 1 before writing a result file, so the run ends as an exit-without-result error rather than quietly running on some other model. That is why the pane path always passes `--provider` and `--model` explicitly, and why an agent type that restricts extensions must keep its model's provider extension in the allowlist.

**The transcript always goes to the child session store**, so `persist_session: false` and `session_dir` do not move it (see below). They govern where the *user's* `/resume` list gets its entries; a pane child needs a file on disk for the parent to read, and it is written outside that list.

## Where the child's transcript lives

```text
<agentDir>/subagent-sessions/<rootSessionId>/<timestamp>_<agent id>.jsonl
```

- **`rootSessionId`** is the session that started the cascade — the main session — so a fan-out of twenty agents files twenty files in one directory, and a grandchild's file sits beside its parent's.
- The child's pi session id *is* the agent id, which is how the parent finds the file. `pi` writes it lazily, on the first turn, so the parent polls for up to 2 s and then keeps looking in the background while the run is live.
- **Outside the user's `/resume` picker** by construction: the directory is passed as `--session-dir`, so agent transcripts survive the pane and reopen from `/agents` without a fan-out filling the session list.
- The `.output` transcript (`output_transcript`, `outputTranscript`) is still written, from the tail: it is appended whenever a turn completes, carrying whole messages because a file has no deltas.

## What the transcript can and cannot show

`/agents`, the widget, FleetView, the conversation viewer and `get_subagent_result({ verbose: true })` read a `PaneSession` — a `RunHandle` over that file. What it holds:

| Shows | Because |
|---|---|
| The conversation, message by message, following the active branch | The tail parses `message` and `compaction` entries and walks `parentId` from the leaf, so an abandoned branch is in the file but not in the conversation |
| Turn count, tool activity, token totals per message and lifetime | Diffed off the file as messages complete |
| The last assistant text, for `get_subagent_result` and error reports | Read back from the tail |
| **Pre-compaction history**, unlike a live session | `messages` is the whole active branch on disk, not pi's compacted working set. The viewer renders it; it is not what the child would send next |

What it cannot:

- **No context-window percentage.** A percentage needs the model's context window, and a session file does not name it. The widget and FleetView show a pane agent's tokens and leave the `NN%` field out — absent rather than wrong.
- **No text deltas, so no live streaming text.** A message reaches the file only when it is complete. The widget's activity line therefore tracks tool calls and turns as they land, and assistant text appears when the message does.
- **Compaction events always report `reason: "threshold"`.** The file records that a compaction happened, not why: an unattended child compacts on its own threshold, and nothing downstream reads the reason for anything but display.
- **No model or thinking level from the child.** The handle reports neither, so the model and level shown for a pane agent are what the spawn resolved, not what `pi` settled on inside the child. A level the model cannot reach is not disclosed as `(asked …)` there.
- **No extension lifecycle.** A child's extensions live in the child process, so `session_shutdown` has nothing to emit into and teardown degrades to a plain dispose.

## Troubleshooting

### No capsules appeared

Work down this list; the first two cost nothing.

1. `echo "$REX_SESSION $REX_BLOCK"` — both must be set and non-empty. Empty counts as absent.
2. `rex whoami --json` — it must exit 0 and print whoami JSON. A different `rex` on `PATH` fails here, and so does a server that is not listening.
3. Is the parent interactive? A `pi -p` run, an SDK or RPC-driven parent has no terminal, so it stays in-process by design.
4. Is `runInRexPanes` `"off"`? Check `/agents → Settings → Rex panes` or `subagents.json`.
5. Has this pi process already spawned an agent? The answer is cached at the first spawn. A restart re-probes.
6. The record says where it ran, and the surfaces built from it — the completion notification and `get_subagent_result` — print `(ran in-process: could not get a pane (creating it failed))`. A warning was raised at the same moment; the note on the record outlives it on purpose.
7. Inside a pane child, its own children are panes in the same Rex session but appear in *that child's* `/agents`, not yours. Open the capsule to see them.

### An agent is blocked

The capsule shows `blocked` and the record shows it as running: the child is sitting at a prompt (a tool permission, a question, a login). No timeout and no auto-abort — a blocked run waits as long as any other run would.

Open the capsule and answer the prompt; the run continues and settles normally. Or abort the agent (see below), which closes the pane and ends the run `stopped`. `steer_subagent` cannot help here and says so rather than typing into the dialog.

### A pane stayed open

Four different things look the same from the outside:

| Cause | What to do |
|---|---|
| The minimize call was refused (`bad_request`, e.g. the window would lose its last visible pane) | Nothing — the child is running fine and the pane finishes with it. The warning named Rex's reason; the agent is merely visible instead of a capsule |
| The child is blocked at a prompt and never settles | Answer it in the pane, or abort the agent |
| The abort or shutdown close failed | The warning said `could not be closed (…); its child may still be running`. Close the pane yourself — nothing else will |
| The parent exited before its pane closed (a wedged server, a quit that could not wait) | An orphan pane is yours to close. Block ids are deliberately not persisted across sessions, so a later pi cannot reclaim it |

A pane is never left open *without a record*: every pane the parent creates is tracked from before the launch until its layer closes, including the window in which the pane exists but the record does not yet have a handle — a quit there still closes it.

### A child could not be minimized

The agent is unaffected: it is running in a visible pane instead of a capsule. The warning carries Rex's own reason (`the pane for "…" was created but could not be minimized, so it stays visible (…)`), and nothing claims otherwise — an agent is never recorded as minimized when `set_layer_state` failed.

### The agent ended as an error with no result

Read the message: `the agent's pi exited with <status> without writing its result file`, then the child's last assistant message and, when the pane still existed, its last lines. The common causes are a bad `--provider`/`--model` combination (see the provider note), a project it was told not to trust (`-na` — what a child gets when the parent session does not trust its project, or when the spawn's `cwd` lies outside it, so a foreign repo's project-local `.pi` files are never vouched for; such a child sees only the files its parent was allowed to), and the pane being closed by hand.

## Where this lives in the code

| File | What it decides |
|---|---|
| `src/rex/detect.ts` | Whether this process can have panes, and the `runInRexPanes` setting |
| `src/rex/launcher.ts` | The child's spec, files and argv; the `session.new_layer` request; create/minimize/close, serialized |
| `src/rex/rex-cli.ts` | Every `rex` call: the never-rejecting exec seam, exit status, program status, captured tail, window lookup |
| `src/rex/pane-run.ts` | The run: compose, launch, minimize, watch, settle, close; resume; steer and abort; the in-process fallback |
| `src/rex/session-tail.ts` | The child's session file as messages, turns and usage |
| `src/rex/pane-session.ts` | `RunHandle` over that file, so every UI surface reads a pane run unchanged |
| `src/rex/child-mode.ts` | The child: spec parsing, tool scope, turn cap, structured output, result file, self-shutdown |

Pinned by `test/rex-detect.test.ts`, `test/rex-launcher.test.ts`, `test/rex-cli.test.ts`, `test/rex-session-tail.test.ts`, `test/rex-pane-session.test.ts`, `test/rex-child-mode.test.ts`, `test/rex-run-handle.test.ts`, `test/rex-pane-run.test.ts` and `test/rex-pane-integration.test.ts`.
