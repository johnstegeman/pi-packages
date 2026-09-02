# @abix5/pi-beads

[![npm](https://img.shields.io/npm/v/%40abix5%2Fpi-beads)](https://www.npmjs.com/package/@abix5/pi-beads)
[![license: MIT](https://img.shields.io/npm/l/%40abix5%2Fpi-beads)](https://github.com/abix5/pi-beads/blob/main/LICENSE)

A context-lean bridge between the [pi coding-agent](https://github.com/earendil-works/pi)
and the [beads](https://github.com/steveyegge/beads) issue tracker (`bd`). The agent
gets compact in-process `beads_*` tools instead of a beads MCP server, a short prime
once per segment instead of once per turn, reads that span every repository of an
umbrella workspace, and writes routed to the owning repository by issue-id prefix.
There is no always-on board next to the editor; `/beads` prints the ready +
in-progress view on demand, and the `beads_*` tools cover every query.

> [!TIP]
> You need the `bd` binary on `PATH` and a `.beads/` directory in the project.
> Without `.beads/` the extension stays quiet — `bd✗` in the status line, tools
> answer with a refusal — so it is safe to install globally and forget about it
> in projects that do not use beads.

## Why

There are two usual ways to put an agent in front of beads, and both are paid for in
context: either a full `bd prime` is poured into every turn, or a beads MCP server is
started and its tool schemas occupy context for as long as the session lives. This
package does neither.

| Approach | Context cost |
|---|---|
| Full `bd prime` every turn | ~1065 tokens × N turns |
| beads MCP server | tool schemas resident for the whole session |
| `@abix5/pi-beads` | `bd prime --mcp` ~141 tokens once per segment, plus ~16–208 token digests per read |

The beads MCP server is skipped deliberately: by the beads documentation it exists for
clients that have no shell. pi has a shell, so calling `bd` directly and folding its
JSON into a digest is the lighter path. Writes go through `bd` directly too — they are
cheap either way.

The numbers above are the estimates recorded in the header of `src/index.ts` during
development, not a measurement on your project; the order of magnitude is right.

## What a session looks like

The status line shows `bd✓` when beads is ready and `bd✗` when the project has no
`.beads/` directory. There is no board drawn beside the editor — run `/beads` to see the
ready + in-progress view, or use the `beads_*` tools.

## Umbrella mode: many repositories, one list

If an umbrella workspace is nearby — a directory whose `bd` aggregates several
repositories — the extension finds it on its own. It can also be named explicitly with
`PI_BEADS_ROOT`.

Reads (`beads_ready`, `beads_list`, `beads_show`, `beads_deps` and the prime) run
against the aggregate, so the agent sees the issues of every repository at once, and an
issue's owner is read off its id prefix: `crmback-1a2` belongs to `crm-backend`.

Writes (`beads_create`, `beads_update`, `beads_close`, `beads_dep`, `beads_undep`,
`beads_comment`) are routed to the owning repository by that same prefix; afterwards the
repository's JSONL is re-exported and the aggregate re-synced, so the next read is
fresh. Writing straight into the aggregate is not allowed: what lives there are
throw-away copies.

With no umbrella around, the extension quietly works in ordinary single-repo mode. The
current mode and the routing table are always one `/beads-mode` away.

## How it works

**Prime.** Instead of a full `bd prime` on every turn, the extension injects a short
`bd prime --mcp` block once per context segment, plus one line naming the id prefixes
and the repositories they route to.

**Reads.** Every read runs `bd` in-process and returns a digest — the fields an agent
acts on — rather than raw JSON.

**Writes.** Each write is dispatched to the owning repository by id prefix, then the
aggregate is re-hydrated so the next read cannot show a stale list.

## Install

```bash
pi install npm:@abix5/pi-beads
```

Then restart pi or `/reload`. The bundled `beads` skill — how to read across
repositories, where to create, how to link — ships inside the package and registers
itself; there is nothing to copy by hand.

## Requirements

- **pi** — the extension declares `@earendil-works/pi-coding-agent` in
  `peerDependencies`, as the pi packages documentation prescribes.
- **Node.js 22.6 or newer** — the code is ESM with `node:` prefixes and the extension is
  loaded as `.ts` through built-in type stripping.
- **The `bd` binary on `PATH`** — this is a wrapper, not an implementation of beads.
  Verified against `bd version 1.0.5 (Homebrew)`.
- **A `.beads/` directory in the project** — created by `/beads-init` or `bd init`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_BEADS_ROOT` | auto-detected | Directory of the umbrella aggregate; understands `~`. Unset, the umbrella is searched for; not found, the extension runs in ordinary single-repo mode |

There is nothing else to configure: the rest is worked out at session start.

## Commands & tools

Commands are run by a person and their output never reaches the model's context.

| Command | What it does |
|---|---|
| `/beads` | A compact board: what is in progress and what is ready, across all repositories |
| `/beads-sync` | Re-hydrate the umbrella aggregate from every repository right now |
| `/beads-init` | Quiet initialization of beads in the current project (see below) |
| `/beads-mode` | Current mode, umbrella, default repository, prefix table, context economics |

The agent gets ten tools. All of them are direct in-process `bd` calls with no MCP
transport, and what comes back is a digest rather than raw JSON.

| Tool | What it does |
|---|---|
| `beads_ready` | Issues ready to work (open and unblocked) across all repositories |
| `beads_list` | A list filtered by status (`open,in_progress,blocked,deferred,closed`) |
| `beads_show` | The essential fields of one issue: status, priority, type, description, dependency counts |
| `beads_deps` | Blockers or dependents: a tree for one id, compact lines for several |
| `beads_create` | Create an issue in the right repository (`repo` is a folder name or a prefix), return its id |
| `beads_update` | Status, priority, title, notes, labels; routed by id prefix |
| `beads_close` | Close one or more ids, with a reason |
| `beads_dep` | Add a dependency (blocker blocks issue) within one repository |
| `beads_undep` | Remove a dependency |
| `beads_comment` | Add a progress comment to an issue |

## Quiet init

`/beads-init` runs `bd init --skip-agents --skip-hooks`. Those two flags mean `bd` will
not write `AGENTS.md`, `CLAUDE.md`, the `.claude/`, `.codex/` and `.agents/` directories,
and will not point `core.hooksPath` at its own git hooks. Your instructions to agents stay
as you wrote them.

> [!NOTE]
> What the flags do not cancel: outside a repository `bd init` still runs `git init`, it
> still appends its lines to the root `.gitignore`, and it commits the files it created.
> That is `bd`'s own behaviour and the extension has no say in it.

## Limitations

beads dependencies live inside a single repository, so `beads_dep` across repositories is
impossible — that is how the storage works. For the same reason writing directly into the
umbrella aggregate is not allowed: routing by id prefix is the only path.

Finally, `bd`'s output format is not a stable contract. Verified against 1.0.5; on other
versions the parsing may drift away from reality.

## Not to be confused with

npm carries an older `pi-beads` package by a different author, depending on the retired
`@mariozechner/*` namespace. That is not this project.

## Development

There is no build step and no automated test suite (the widget tests were removed with
the widget): after editing, `/reload` in pi.

Licensed [MIT](https://github.com/abix5/pi-beads/blob/main/LICENSE).
