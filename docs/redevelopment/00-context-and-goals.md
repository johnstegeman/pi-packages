# 00 — Context, goals, and open questions

## The mission

Redevelop the extensions of this monorepo as **four repos** (topology confirmed
2026-11-02; it matches the measured coupling graph — repo 1 is the one
inseparable cluster, repos 2–4 are genuinely independent, and the only
cross-repo seams are the `superpowers:phase` event and an environment-level
defaultProvider setting):

1. **Hard stack: pi + beads + rex.** No fallback paths when a component isn't installed.
   Today's code carries a number of graceful-degradation paths (listed per package);
   a core design task of the redevelopment is deciding, for each, whether it becomes
   a hard error, or whether the feature itself is dropped.

1a. **UI posture: Rex panes replace in-TUI subagent UI.** Subagents already run as real
    pi processes in minimized floating Rex panes — the Rex-pane mode is implemented
    and live in pi-subagents, `runInRexPanes: "auto"` by default inside Rex; see 06
    §Rex panes), so the elaborate in-TUI subagent surfaces — live agent widget, FleetView, conversation
    viewer — are **not needed** in the new repo. Glanceability comes from the pane
    capsules; inspection comes from opening the pane. What still needs a home: the
    *record* of finished agents and their transcripts, and result retrieval
    (`get_subagent_result`). See **[decide] Q11**.
1b. **Superpowers progress widget may also become a floating pane.** Consider
    rendering the beads-molecule progress (phase label, current step, gate states,
    done/total) in a Rex floating pane rather than (or in addition to) the in-TUI
    molecule widget. Design consequence: a pane runs a *program*, so this is a
    small dedicated renderer process (e.g. polling `bd mol current --json`) rather
    than in-process TUI drawing. **Event-bus finding (verified against the pi
    1.5.0 docs): an external app cannot listen on `pi.events` — it is the
    in-process bus "for communication between extensions"; RPC mode streams
    only fixed session events + an extension-UI subprotocol (which does
    forward `setWidget` records, but only to an RPC-mode parent) — custom
    events like `beads:changed` never leave the process.** The event-driven
    path is therefore a **bridge extension**: subscribe to `beads:changed` +
    `superpowers:phase` in the parent and forward to the pane app over a unix
    domain socket, or write an atomic state file it `fs.watch`es (the same
    "external process reads what pi writes" philosophy pi-subagents uses for
    pane-child session files). Big win: the `bd mol current` query and its
    Dolt-lock contention gate stay in the parent — the pane renderer never
    touches bd (no polling cadence, no lock contention from the pane).
    Remaining sub-questions: whether a minimized pane/capsule can carry a
    meaningful label (the bridge could feed it the phase); whether to keep a
    minimal in-TUI widget for non-Rex moments; the polling-`bd` fallback
    (no pi coupling, but ~2 s latency per tick + the contention gate must be
    ported into the renderer). See **[decide] Q12**.
2. **VCS: worktrunk, jj (jujutsu), or a combination — undecided, but the
   worktrunk+jj hybrid (option 5) is verified workable and the leading
   candidate.** See [02-vcs-considerations.md](02-vcs-considerations.md) for
   the measured change surface, the live-probe findings, and the ginit
   bootstrap recipe; the final call is still open (**[decide] Q1**).
3. **Repo topology** (replaces the old "out of scope" framing):

   | Repo | Contents | Inventory status |
   |---|---|---|
   | **pi-rex** — https://github.com/johnstegeman/pi-rex (play on Pyrex: the pi+rex stack that takes the heat; repo created, currently empty) | superpowers, beads, subagents, codemode-bootstrap | **fully inventoried** — files 03, 05, 06, 07 are its primary input |
   | **pi-carte** — https://github.com/johnstegeman/pi-carte (à la carte / carte du jour: the menu *is* the model catalog, ordering à la carte *is* per-request routing, and the carte is the record of what was served; "carte" also echoes *chart*) | bifrost + langfuse | **fully inventoried** — file 08 is its primary input |
   | **pi-garnish** — https://github.com/johnstegeman/pi-garnish (a garnish exists purely for presentation) | ayu color scheme + statusline (with jj support) | **fully inventoried** — file 09 is its primary input |
   | **pi-whetstone** — https://github.com/johnstegeman/pi-whetstone (you sharpen your most important tools on it — matches the broad "make pi better" mandate, room for future generic tool overrides) | hashline-edit | **fully inventoried** — file 04 is its primary input |

   Per-repo notes:
   - **codemode-bootstrap stays in pi-rex** (not repo 4): it exists to guarantee
     pi-rex's own codemode-exposure policy; nothing outside pi-rex uses codemode
     exposure (hashline's read/edit are direct).
   - **statusline's jj work is more than "support"**: its git-status segment is
     functionally dead under jj (autosnapshot keeps `git status` clean) — needs a
     real jj path (`jj diff --summary`/`jj st`, bookmark-vs-remote for
     ahead/behind), and branch display becomes the **workspace/worktree
     name** (decision 2026-11-02: don't show branch/bookmark at all — the
     dir basename is VCS-agnostic, equals the branch by wt convention, and
     doubles as the bookmark selector for the ahead/behind revset; see 09 §3).
     detaches after every jj commit under the option-5 hybrid). Also its one
     deliberate fallback-by-design: dual-mode (plain-git repos must still work) —
     the exception to the no-fallback posture, since a statusline must work in
     any repo you open.
   - **ginit / bootstrap is owned by pi-rex**: the ginit recipe (implemented at
     `~/ginit.fish`, tested — see 02 §7), worktrunk hooks config, and
     `.worktreeinclude` ship in pi-rex's docs/skills. Each repo runs beads
     **standalone** (own db, own dolt remote — Q8), not in an umbrella.
   - **Gate machinery**: the full package-gate + dep-mirror + manifest CI is
     worth keeping only in pi-rex (multi-package, vendored forks, the
     false-green history); repos 2–4 are 1–2 packages each — a single
     package.json and a plain CI test job is the right size.
   - **pi-packages archive plan**: once migration lands, archive this repo; its
     `.beads` stays as the historical record.

## What the inventoried packages are, in one line each

(The pi-rex four, plus hashline-edit which lands in pi-whetstone.)

- **codemode-bootstrap** — makes pi's `codemode` tool (JS scripting sandbox that calls
  other tools) reliably active in every session, including nested/subagent sessions.
- **hashline-edit** — overrides `read`/`edit` with hash-anchored line references so
  edits are verified against the exact file state that was read; opt-in `grep`.
- **pi-beads** — in-process `beads_*` tools bridging to the `bd` CLI (issue tracker
  across an umbrella of repos), a beads operating-doctrine skill, and per-molecule
  cost tracking.
- **pi-subagents** — vendored fork of tintinweb/pi-subagents: background/nested agent
  dispatch, agent types & templates, workflows, TUI widgets, worktree isolation;
  a live Rex-pane execution mode — the default inside Rex, each subagent a real
  pi process in a minimized floating pane (the design doc's "Status: draft" line
  is stale; the code ships and is tested).
- **pi-superpowers-plus** — vendored Superpowers skills (brainstorming, TDD,
  debugging, …) plus the `set_phase` extension, beads-molecule widget, formula seed,
  and agent templates; beads (molecules/gates) is the structural persistence layer of
  the whole workflow.

## Cross-package integration map (what talks to what)

Interactions between the kept packages, collected in one place (details live in
the per-package files):

**pi event bus:**

- `beads:changed` — emitted by pi-beads after every successful mutating call →
  consumed by the pi-superpowers-plus molecule widget (leading-edge + 10 s
  trailing coalesced refresh).
- `subagents:completed` / `subagents:failed` — emitted by pi-subagents on
  top-level agent settles → consumed by pi-beads' cost-tracking extension
  (reads the `bead: <id>` token from the Agent `description`, writes `cost.*`
  metadata on the task bead) → which itself emits `beads:changed`.
- `superpowers:phase` — emitted by the `set_phase` tool (cleared on session
  start/shutdown) → consumed by the molecule widget (non-empty phases trigger a
  refresh); today also consumed by langfuse and bifrost (both dropped — Q5);
  candidate for driving Rex pane labels (Q12).

**Codemode exposure interplay:** codemode-bootstrap activates `codemode` in
every session; pi-subagents additionally activates it inside each subagent
session (inline factory + allowlist exemption + nested-call scope veto); all 23
pi-beads tools plus `get_subagent_result`, `steer_subagent`, and
`SubagentWorkflow` are codemode/deferred-exposure only — **without codemode
they are unreachable**. `Agent` and hashline-edit's read/edit stay direct.

**Shared contracts:**

- `scripts/fixtures/workspace-key-vectors.json` — golden vectors for the
  workspace key, shared by pi-beads (`ws:<key>` stamping on molecule roots) and
  the molecule widget (multi-worktree disambiguation).
- The workflow formula + pour-time `step:<key>` labels couple the superpowers
  skills, the molecule widget, and the coupling tests.
- pi-beads exposes `getBeadsRuntime()` (`{ bd, dirForPrefix, afterWrite }`) to
  its sibling cost-tracking extension (in-package only).
- pi-subagents exposes a `globalThis[Symbol.for("pi-subagents:manager")]`
  registry + cross-extension RPC channels for other extensions.
- The superpowers skills are the doctrinal consumer of both tool families
  (`beads_*`, `Agent`/`SubagentWorkflow`); `pi-tools.md` enumerates the tool
  surface and the tool-surface tests keep it in sync.

**Deliberate duplication (no cross-package imports):** `lock-retry.ts`
(pi-beads) and `dolt-lock-retry.mjs` (pi-superpowers-plus) are hand-kept copies
of the same Dolt lock/cancel retry logic. A new repo must either keep the
duplicate-and-sync rule or extract a shared module (**[decide] Q4**).


## Repo-level design posture worth carrying over (see 01 for details)

- Deterministic installs (`npm ci`, committed lockfiles per package, never `npx`).
- The package gate: every package's declared check/typecheck/test scripts must be run,
  discovered automatically, never silently skipped; quarantine requires a reason + bead id.
- The dep-mirror gate: an extension loaded from the repo root must have its runtime
  deps mirrored in the root package.json.
- Design history as first-class docs (`docs/superpowers/specs|plans`), now largely
  superseded by beads-as-persistence (molecules/gates), which is itself the model the
  new repo should assume from day one.
- Tool-argument strictness: `execute` may receive undeclared keys; write tools reject
  unknown keys by name rather than silently dropping them
  (`docs/pi-extension-args-contract.md`).

## Current environment facts (verified on this machine)

- pi `1.5.0`; repo installed as a package via
  `pi install git:github.com/johnstegeman/pi-packages` (registered in
  `~/.pi/agent/settings.json` → `packages`), so the whole monorepo install provides
  all extensions + skills at once.
- Node pinned to **22** via `mise.toml` (root). jj 0.46.0 and worktrunk are installed
  and in active use; the checkout is a **bare repo + linked worktree** layout
  (`/…/pi-packages` bare, `/…/pi-packages/main` worktree, managed by worktrunk).
- beads: embedded Dolt backend, `bd init --skip-hooks`, `.beads/` git-ignored; an
  opt-in shared Dolt server path exists for multi-worktree write contention
  (`docs/beads-dolt-server.md`). The umbrella currently contains a single repo
  (`pi-packages`), but the beads tooling is built for multi-repo umbrellas.
- Global agent templates live at `~/.pi/agent/agents/*.md` (code-reviewer, explore,
  implementer, task-reviewer, verifier, worker) — same names the Agent tool surfaces.
- MCP: a `superlogical` (Rex) codemode server is configured; rex skill at
  `~/.agents/skills/rex`.

## Open questions to settle before/while speccing ([decide] items)

Batched — answers will steer multiple specs:

1. **Q1 — VCS.** worktrunk (git bare + linked worktrees, status quo), jj colocated
   (one working copy), or jj colocated + worktrunk-style multi-worktree via
   `jj workspace add --colocate`? Or jj workspaces with git fallback eliminated?
   Drives: subagent worktree isolation, statusline-equivalent git segments (out of
   scope anyway), skill prose, `review-package` diff ranges, formula-seed root
   resolution. See 02. A fifth hybrid — worktrunk creates the git worktree, jj
   colocates *inside* it — was **verified workable by live probe (2026-11-02)**,
   including the refined flow (jj creates the branch via bookmark, wt attaches the
   worktree, a bookmark-set + git-checkout re-attach keeps wt's branch view
   intact); see 02 §4 option 5 and §6 findings.
2. **Q2 — Fallback policy granularity.** "No fallbacks" at which layer?
   (a) Extension startup: missing `bd`/`rex` binary = extension fails loudly /
       session refuses to start?
   (b) Per-operation: e.g. pi-subagents' designed in-process fallback when a Rex pane
       can't be created — keep as an explicit *reported* fallback, or make Rex a hard
       requirement and error?
   (c) Feature-level: e.g. pi-beads' optional-startup probe (beads not initialized →
       tools hidden). New repo: hard-require initialized `.beads/`?
3. **Q3 — Vendored vs re-implemented.** pi-subagents and pi-superpowers-plus are
   vendored forks with local divergence records. New repo: continue vendoring (carry
   the fork), or clean-room re-implement only the parts you actually use?
4. **Q4 — Monorepo shape (scoped to pi-rex).** Keep the packages/<name> + root
   manifest + package-gate model for its four packages, or collapse into a
   single package (single package.json, single gate) since the stack is now
   homogeneous (everything assumes pi+beads+rex)? Resolved for repos 2–4:
   single package + plain CI each.
5. **Q5 — Cross-package seams — RESOLVED by the topology.** The only code-level
   seam is the `superpowers:phase` event, which becomes a **published
   cross-repo contract**: pi-rex emits (canonical phases `brainstorming` /
   `development` / `""`), pi-carte subscribes — this works
   across repos because `pi.events` is process-wide over all loaded
   extensions regardless of origin package. Residual work item: document and
   stabilize the event name/shape in pi-rex so repo 2 can depend on it by
   name. (statusline reads its own settings file — independent; bifrost as
   defaultProvider is environment-level, not code.)
6. **Q6 — Distribution (per-repo).** Each repo is independently installable
   (`pi install git:…`) with its own release cadence — users install exactly
   what they want; pi-rex alone delivers the whole workflow. pi-rex keeps the
   full gate + manifest-validation + actionlint CI (the false-green history
   justifies it); repos 2–4 get a plain CI test job. Open: does pi-rex also
   publish to npm or stay git-install only?
7. **Q7 — Codemode.** Is codemode (pi built-in) assumed present in the new stack
   (making codemode-bootstrap trivial/unnecessary), or still conditional on pi
   version/config? See 03.
8. **Q8 — Beads topology — RESOLVED: independent per-repo databases, no
   umbrella** (decision 2026-11-02). Each repo gets its own `.beads` (ginit
   points its dolt remote at its own gh repo), so issue data travels with the
   code and fresh clones recover it via `bd bootstrap` (gclone flow).
   Single-repo mode is first-class in both bd and pi-beads (tested modes;
   simpler prime block; no prefix-routing machinery). Given up by design: the
   cross-repo aggregate `bd ready`/`bd list` view, and cross-repo issue links
   (already structurally impossible in beads — coordination stays prose).
   pi-packages' `.beads` stays as the archived historical record. Residual:
   does anything need to be *carried* (open issues worth re-filing), or is a
   clean cut acceptable?
9. **Q9 — VCS doctrine for agents (answer taking shape: pi-rex ships jj doctrine).**
   The Superpowers skills are heavily git-cmd-literate (~50 hardcoded git commands
   across ~20 skill files), and agents' *default instincts* are git. If any jj
   variant of Q1 is chosen, pi-rex should ship:
   - a **`jj` SKILL.md** following the beads-skill pattern (ships in the package;
     loaded as a skill it propagates automatically to every pane child too,
     unless isolated) teaching the conventions *and the measured footguns*:
     bookmarks are the branch-equivalent and move only explicitly (`jj bookmark
     set`), `jj commit` leaves git HEAD detached (the wt re-attach flow:
     `jj bookmark set <b> -r @-` + `git checkout <b>`), `git status` shows the
     snapshot as staged diffs, untracked-not-ignored files are absorbed into `@`,
     gitignored files are invisible, git hooks never fire, conflicts/op-log/
     `jj split`/`jj undo`, and worktree creation via `jj workspace add --colocate`
     vs `wt switch`;
   - **AGENTS.md statements** in pi-rex naming the VCS and the re-attach workflow;
   - **jj-aware SDD scripts** (code, not prose — `review-package` ranges →
     `jj diff --from --to`, wave-parallel per-workspace; see 02 §2);
   - a **wt alias** for the re-attach step so humans and agents have one command.
   Residual decision: rewrite the git-literate skill *prose* for jj vs keep it
   VCS-agnostic and concentrate jj knowledge in the skill + scripts.
10. **Q10 — The Rex-pane execution mode (implemented and live).** The design in
    `docs/superpowers/specs/2026-11-02-subagents-in-rex-panes-design.md` is **shipped
    code** — `src/rex/` + child mode in the vendored pi-subagents, default
    `runInRexPanes: "auto"` inside Rex (the doc's "Status: draft" line is stale).
    So the question is not whether the new repo adopts it — it's the baseline —
    but the no-fallback inversions: does the new repo keep the in-process runner
    at all (Q11's pane-only option), and what happens on pane-creation failure
    (today: reported in-process fallback; hard-rex-stack alternative: error).
    See 06 §Rex panes and 06 §11. **Two diagnosed pane bugs to fix in pi-rex v1**:
    pane bounds too small to read (42% × 12%), and `watchExit` misreading `rex
    wait`'s window timeout (exit 1, empty stdout, `context deadline exceeded`) as
    "pane could not be reached" — a spurious warning on every run longer than one
    30 s window (observed live on 2026-11-02; diagnosis and fix direction in
    06 §Rex panes).
11. **Q11 — Subagent UI in the new stack.** With Rex panes providing glance/open/steer,
    how much of pi-subagents' in-TUI surface survives? Candidates to drop: live agent
    widget, FleetView, conversation viewer, agent-activity tracker plumbing. Candidates
    to keep (possibly redesigned): `/agents`-equivalent finished-agent record + transcript
    access, `get_subagent_result`/`steer_subagent` tools, handle/status bookkeeping,
    completion notifications. Also: does the pane path become the *only* path (no
    in-process runner at all), matching the no-fallback posture? **User feedback
    (2026-11-02): the panes as currently sized are too small to see anything** —
    the shipped bounds are 42% width × 12% height (6 cascading lanes), so an
    opened pane is a sliver. pi-rex v1 must revisit pane sizing (larger default
    bounds, grid instead of cascade, and/or minimized-capsule +
    expand-on-demand as the real UX) — this weakens the "inspection comes from
    opening the pane" premise until fixed. See 06 §Rex panes.
12. **Q12 — Superpowers progress in a pane.** Render molecule/workflow progress in a
    Rex floating pane (dedicated renderer process), the in-TUI widget, or both?
    Refresh channel is settled in principle: `pi.events` is in-process only
    (verified — RPC mode carries session events + extension-UI records, not
    custom events), so the event-driven design is a **bridge extension**
    (unix socket or atomic state file + `fs.watch`) that keeps the bd query
    and its Dolt contention gate in the parent and makes the pane a pure
    renderer; the alternative is the pane polling `bd mol current --json`
    itself (~2 s latency + ported contention gate). Open: pane label as phase
    carrier (fed by the bridge), auto-create at molecule pour / auto-close at
    finish, whether `set_phase` drives pane updates via the same channel, and
    whether a minimal in-TUI widget survives for non-Rex moments.
