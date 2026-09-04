# pi-superpowers-plus

![pi-superpowers-plus banner](banner-plus.jpg)

Structured workflow skills for [pi](https://github.com/badlogic/pi-mono).

Your coding agent doesn't just know the rules - it follows them. Skills teach the agent *what* to do (brainstorm before building, write tests before code, verify before claiming done). The tooling that supports that workflow — subagent dispatch and task tracking — comes from two companion packages that ship with the [pi-packages monorepo](https://github.com/johnstegeman/pi-packages) install.

## What You Get When You Install This

**13 workflow skills** that guide the agent through a structured development process - from brainstorming ideas through shipping code. 11 of them are hidden from the system prompt and load on demand, so the context stays lean — only `using-superpowers` and `systematic-debugging` remain visible. There's no runtime enforcement layer watching tool calls; phase loading is via pi's native `/skill:` expansion (see [Phase Commands](#phase-commands) below).

**Two companion packages** provide the tooling the skills reference (bundled with the `pi-packages` monorepo install):
- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) — registers the `Agent` / `get_subagent_result` / `steer_subagent` tools for dispatching implementation and review work to isolated in-process subagents, with a persistent widget, FleetView, mid-run steering, and session resume.
- **forked [`pi-beads`](https://github.com/abix5/pi-beads)** — registers the `beads_create` / `beads_update` / `beads_close` / `beads_dep` / `beads_list` / `beads_show` tools for beads issue tracking — persistent issues for plan work, wisps (`ephemeral: true`) for session phase bookkeeping. The fork (bundled in this monorepo) adds the `ephemeral`/wisp support that upstream v0.2.2 lacks. The live workflow display is provided by this package's own `beads-molecule-widget` extension, not by pi-beads.

There's no runtime enforcement layer watching tool calls — the discipline (TDD, verification before claiming done, branch safety, etc.) lives entirely in the skill instructions the agent reads and follows.

## Phase Commands

Phase entry is command-driven: the phase skills are hidden from the system prompt and load on demand when you type one of the six phase commands:

| Command | Loads |
|---------|-------|
| `/brainstorming` or `/brainstorm` | `brainstorming` |
| `/plan` | `writing-plans` |
| `/execute` | presents the Subagent-Driven Development vs Executing Plans choice in the editor |
| `/verify` | `verification-before-completion` |
| `/review` | `requesting-code-review` |
| `/finish` | `finishing-a-development-branch` |

Each command is an `input` transform that rewrites to `/skill:<name>` before pi's native skill expansion, so the next skill always loads the same way — never improvised. Extra arguments are preserved (`/brainstorm build a chat app` → `/skill:brainstorming build a chat app`). `/execute` doesn't rewrite to a single skill; it stages the implementation phase and presents the two execution approaches in the editor — pick one and type its `/skill:` command.

Because the hidden skills are not model-invocable, every phase skill — plus the supporting skills — is also `/skill:`-invocable any time (`/skill:test-driven-development`, `/skill:writing-plans`, etc.).

## Prerequisites

This package provides skills and agent templates only — it no longer bundles its own tools. The two companion packages (pi-subagents and the pi-beads fork) are provided by the [pi-packages monorepo](https://github.com/johnstegeman/pi-packages) install — **no separate install is needed**:

```bash
pi install git:github.com/johnstegeman/pi-packages
```

The skills reference `Agent(...)` and the `beads_*` tools directly. There is **no fallback** if the tools aren't present — the skills assume they are available (both ship in the monorepo install). Beads must also be initialized in a project (a `.beads/` directory) for the tracking tools to work. Task tracking (`beads_create`/`beads_update`/`beads_close`) is persistent for plan-step work and wisp-based (`ephemeral: true`) for session phase bookkeeping. From an umbrella root, pass the owning repo explicitly to `beads_create` (`repo` is required there); otherwise it defaults to the session's repo.

## Install

This package is vendored as `packages/pi-superpowers-plus/` inside the [pi-packages monorepo](https://github.com/johnstegeman/pi-packages). The standalone repo is deprecated. Install the monorepo to get this package plus its companion packages (`pi-beads`, `pi-subagents`):

```bash
pi install git:github.com/johnstegeman/pi-packages
```

Then copy the agent templates into a location `pi-subagents` discovers (see its [Custom Agents](https://github.com/tintinweb/pi-subagents#custom-agents) docs):

```bash
# Global (available everywhere) — pick this or the project-local option:
cp agent-templates/*.md ~/.pi/agent/agents/

# Or project-local (this project only):
mkdir -p .pi/agents && cp agent-templates/*.md .pi/agents/
```

The templates are copy-in only — they are never auto-loaded from this package's directory and never overwritten by an update. Re-copy after upgrading if you want the upstream changes, or keep your local edits.

No other configuration required. Skills activate automatically.

## Support

- Questions / support: https://github.com/johnstegeman/pi-superpowers-plus/discussions
- Bugs: https://github.com/johnstegeman/pi-superpowers-plus/issues/new/choose
- Feature requests: https://github.com/johnstegeman/pi-superpowers-plus/issues/new/choose
- Roadmap: [`ROADMAP.md`](ROADMAP.md)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Upgrading from `pi-superpowers`

If you're currently using [`pi-superpowers`](https://github.com/coctostan/pi-superpowers), `pi-superpowers-plus` is intended as a drop-in upgrade: you keep the same skill names and workflow, with pi-specific tooling layered on top.

### What stays the same
- The same core workflow skills (e.g. `/skill:brainstorming`, `/skill:writing-plans`, `/skill:executing-plans`, etc.)
- The same "structured workflow" idea and phase order

### What's new in `pi-superpowers-plus`
- **Three-scenario TDD model** — new feature (full TDD), modifying tested code (run existing tests), trivial change (judgment) — applied consistently across skills, agent templates, and plan templates
- **Subagent dispatch** via [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (`Agent` tool) for delegating implementation/review work to isolated in-process subagents
- **Task tracking** via forked [`pi-beads`](https://github.com/abix5/pi-beads) (`beads_create`/`beads_update`/`beads_close`/`beads_dep` tools) — persistent issues for plan work, self-owned wisps for phase bookkeeping
- Restored inline red flags, rationalizations, and verification checklists in several skills for more self-contained guidance

### Migration
Replace `pi-superpowers` with `pi-superpowers-plus` in your config — the companion packages are bundled, so a single monorepo install covers everything (see Prerequisites):

```bash
pi install git:github.com/johnstegeman/pi-packages
```

Notes:
- If you keep both `pi-superpowers` and `pi-superpowers-plus` enabled, you may get duplicate/competing skill guidance.

### How the skills differ (leveraging pi)

`pi-superpowers-plus` uses pi's runtime capabilities alongside skill content:
- **Three-scenario TDD** — skills, agent templates, and plan templates all use the same model: new feature (full TDD), modifying tested code (run existing tests), trivial change (use judgment).
- The **widgets** from `pi-subagents` (live agents / FleetView) and this package's `beads-molecule-widget` extension (active workflow step) show progress above the editor. (The old pi-beads widget was removed; beads issue/progress display now lives in this package's molecule widget.)
- Tools like **`beads_create`/`beads_update`/`beads_close`** and **`Agent`** store execution state and run subagents outside the prompt.
- Reference material that used to bloat a skill's `SKILL.md` was split into separate reference files in the skill's own directory (e.g. `reference/rationalizations.md`), which the agent reads on demand instead of loading everything up front.

To make this concrete, here's the size of each skill's `SKILL.md` compared to the original [`coctostan/pi-superpowers`](https://github.com/coctostan/pi-superpowers) (approximate KB, at time of writing). Across the shared skills, total `SKILL.md` content went from **67.5KB → 66.5KB**. Skills that shrank moved content into separate reference files loaded on demand; skills that grew restored inline red flags, rationalizations, and verification checklists for self-contained guidance.

| Skill | pi-superpowers (KB) | pi-superpowers-plus (KB) | Change |
|---|---:|---:|---:|
| `brainstorming` | 2.5 | 2.9 | +16% |
| `dispatching-parallel-agents` | 6.2 | 6.1 | -2% |
| `executing-plans` | 2.7 | 3.5 | +30% |
| `finishing-a-development-branch` | 4.3 | 4.4 | +2% |
| `receiving-code-review` | 6.2 | 5.8 | -6% |
| `requesting-code-review` | 2.9 | 3.0 | +3% |
| `subagent-driven-development` | 10.2 | 11.3 | +11% |
| `systematic-debugging` | 9.8 | 7.2 | -27% |
| `test-driven-development` | 9.8 | 8.1 | -17% |
| `using-git-worktrees` | 5.5 | 6.1 | +11% |
| `verification-before-completion` | 4.1 | 4.3 | +5% |
| `writing-plans` | 3.3 | 3.8 | +15% |

## The Workflow

The skills guide the agent through a consistent development cycle:

```
Brainstorm → Plan → Execute → Verify → Review → Finish
```

| Phase | Skill | What Happens |
|-------|-------|--------------|
| **Brainstorm** | `/skill:brainstorming` | Refines your idea into a design document via Socratic dialogue |
| **Plan** | `/skill:writing-plans` | Breaks the design into bite-sized TDD tasks with exact file paths and code |
| **Execute** | `/skill:executing-plans` or `/skill:subagent-driven-development` | Works through tasks in batches with review checkpoints |
| **Verify** | `/skill:verification-before-completion` | Runs tests and proves everything works - evidence before claims |
| **Review** | `/skill:requesting-code-review` | Dispatches a reviewer subagent to catch issues before merge |
| **Finish** | `/skill:finishing-a-development-branch` | Presents merge/PR/keep/discard options and cleans up |

Progress through the workflow is tracked as a real beads molecule — a dependency graph
poured from a formula, with human-approval gates as first-class nodes (design, spec, plan,
and smoke-test sign-off) instead of prose instructions. Plan tasks are beads with their
full instructions in the `description` field, not a separate markdown plan file; the spec
document remains a markdown file, linked from its bead via `--spec-id` for traceability.
This package's `beads-molecule-widget` extension renders the active pipeline's current/next step above the editor.

### Supporting Skills

These skills are used within the main workflow as needed:

| Skill | When It's Used |
|-------|---------------|
| `/skill:test-driven-development` | During execution |
| `/skill:systematic-debugging` | When tests fail repeatedly |
| `/skill:using-git-worktrees` | Before execution - creates isolated branch workspace |
| `/skill:dispatching-parallel-agents` | When multiple independent problems need solving concurrently |
| `/skill:receiving-code-review` | When acting on review feedback - prevents blind agreement |

## How the Skills Work Together

Skills are markdown files the agent reads to learn *what* to do; discipline (TDD, investigating before fixing, verifying before claiming done) is entirely self-enforced by following the skill instructions — there's no runtime monitor watching for violations.

| Agent Behavior | Skill |
|---|---|
| Write test before code | `test-driven-development` (three-scenario) |
| Investigate before fixing | `systematic-debugging` |
| Run tests before claiming done | `verification-before-completion` |
| Follow workflow phases | All skills cross-reference each other |
| Dispatch implementation work | `subagent-driven-development` (uses the `Agent` tool from `@tintinweb/pi-subagents`) |
| Review before merge | `requesting-code-review` (dispatches a `code-reviewer` agent) |

## Subagent Dispatch

Subagent dispatch is provided by [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), which runs subagents **in-process** via the pi SDK — no subprocess, no stdout parsing, no hand-rolled inactivity watchdog. It ships with the monorepo install (see Prerequisites); the `Agent`, `get_subagent_result`, and `steer_subagent` tools become available.

### Agent Templates

This package ships 4 agent templates (copy-in only — see Install):

| Agent | Purpose | Tools |
|-------|---------|-------|
| `implementer` | Strict TDD implementation | read, write, edit, bash |
| `worker` | General-purpose task execution | read, write, edit, bash |
| `code-reviewer` | Production readiness review (read-only) | read, bash, find, grep, ls |
| `task-reviewer` | Task review: spec compliance + code quality (read-only) | read, bash, find, grep, ls |

Templates live in `agent-templates/*.md` and use YAML frontmatter (per the `pi-subagents` schema) to declare tools and a system prompt body. Copy them into `.pi/agents/` (project) or `~/.pi/agent/agents/` (global) so `pi-subagents` discovers them.

### Single Agent

```ts
Agent({
  subagent_type: "implementer",
  prompt: "Implement the retry logic per docs/superpowers/plans/retry-plan.md Task 3",
  description: "Implement retry logic",
})
```

### Parallel Tasks

Dispatch multiple `Agent` calls in the same response — pi runs sibling tool calls concurrently:

```ts
Agent({ subagent_type: "worker", prompt: "Fix failing test in auth.test.ts", description: "Fix auth tests" })
Agent({ subagent_type: "worker", prompt: "Fix failing test in cache.test.ts", description: "Fix cache tests" })
```

For long-running independent work where you want to keep working while agents run, add `run_in_background: true` to each call — you'll be notified on completion and can retrieve results with `get_subagent_result`.

### Resuming an Agent

Round 1-3 of a fix loop resume the original implementer's session:

```ts
Agent({ subagent_type: "implementer", resume: "<agent_id>", prompt: "<findings>" })
```

### Custom Agents

Add `.md` files to `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). `pi-subagents` discovers them automatically (see its [Custom Agents](https://github.com/tintinweb/pi-subagents#custom-agents) docs for the full frontmatter schema). The filename becomes the agent type name.

## Compared to Superpowers

Based on [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent, ported to pi as [pi-superpowers](https://github.com/coctostan/pi-superpowers), then extended with pi-specific tooling.

| | [Superpowers](https://github.com/obra/superpowers) | [pi-superpowers](https://github.com/coctostan/pi-superpowers) | **pi-superpowers-plus** |
|---|---|---|---|
| **Platform** | Claude Code | pi | pi |
| **Skills** | 13 workflow skills | Same 13 skills (pi port) | Same 13 skills (three-scenario TDD, restored inline guidance) |
| **TDD discipline** | Skill tells agent the rules | Skill tells agent the rules | Skill tells agent the rules (three-scenario model) |
| **Debug discipline** | Manual discipline | Manual discipline | Manual discipline |
| **Subagent dispatch** | — | — | `@tintinweb/pi-subagents` (`Agent` tool) + 4 agent templates |
| **TDD in subagents** | — | — | Three-scenario TDD instructions in agent templates + prompt templates |
| **Task tracking** | — | — | beads via forked `pi-beads` (`beads_create`/`beads_update`/`beads_close`) — persistent issues + wisps |
| **Reference content** | Everything in SKILL.md | Everything in SKILL.md | Inline guidance + separate reference files loaded on demand |

## Architecture

```
pi-superpowers-plus/
├── agent-templates/                  # Copy-in agent definitions (4 templates, not auto-loaded)
│   ├── implementer.md                # Strict TDD implementation agent
│   ├── worker.md                     # General-purpose task agent
│   ├── code-reviewer.md              # Production readiness reviewer
│   └── task-reviewer.md              # Task reviewer (spec + code quality)
├── skills/                           # 13 workflow skills (26 markdown files)
│   ├── using-superpowers/
│   ├── brainstorming/
│   ├── writing-plans/
│   ├── executing-plans/
│   ├── subagent-driven-development/
│   ├── test-driven-development/
│   ├── systematic-debugging/
│   ├── verification-before-completion/
│   ├── requesting-code-review/
│   ├── receiving-code-review/
│   ├── dispatching-parallel-agents/
│   ├── using-git-worktrees/
│   └── finishing-a-development-branch/
└── README.md
```

## Development

```bash
npm install
npm test        # biome check .
```

No compiled code or unit tests remain in this package — it ships skills and agent templates only. `npm test` runs `biome check .` (the lint/quality gate). Add tests back alongside any future code.

## Attribution

Skill content adapted from [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT). This package builds on [pi-superpowers](https://github.com/coctostan/pi-superpowers). Subagent dispatch is provided by [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) and task tracking by beads (a [`pi-beads`](https://github.com/abix5/pi-beads) fork with `ephemeral`/wisp support; bundled with the pi-packages monorepo install).

## License

MIT - see [LICENSE](LICENSE) for details.
