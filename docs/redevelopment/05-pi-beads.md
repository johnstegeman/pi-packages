# 05 — pi-beads: feature inventory

Source: `packages/pi-beads/` — vendored fork of `abix5/pi-beads` (forked from v0.2.2,
2026-08-26; local version 0.4.0, owned by this repo, no upstream sync). Verified
against **bd 1.2.2** (bd's output format is explicitly *not* a stable contract).

## Purpose & architecture

A **context-lean bridge** between pi and the beads `bd` CLI. Deliberately NOT a
beads MCP server (~10–50k tokens of resident schemas) and not a full `bd prime`
(~1065 tokens) every turn. Instead:

- Injects a lean `bd prime --mcp` block (~141 tokens) **once per context segment**.
- Read tools return compact **digests** (~16–208 tokens) instead of raw JSON.
- Writes pass through `bd` directly (cheap).

### Core mechanics

1. **`bd()` invocation**: `execFile` (never a shell — no injection surface),
   default cwd = umbrella, `maxBuffer` 8 MB, default timeout 15 s. Never throws.
2. **Transient-failure retry** (`src/lock-retry.ts`, deliberately a hand-kept copy
   of pi-superpowers-plus's `dolt-lock-retry.mjs` — the packages must not import
   each other): embedded-Dolt **lock** errors (`/database is locked|locked by
   another dolt process|embeddeddolt/i`) retry 5×/delays [50,150,400,900] ms;
   **cancel/timeout** (killed flag, `context canceled`, `context deadline
   exceeded`) retry 2×/250 ms; lock text beats cancellation; exhausted
   cancellation reports "bd timed out after N attempts (timeout Xms)".
3. **Umbrella/topology discovery** (`resolveTopology()`): root = `PI_BEADS_ROOT`
   env (no fallback to a cwd DB if the configured root has none), else walk up to
   12 parent dirs from session cwd for a `.beads` whose `bd repo list` shows
   additional repos (hydration = umbrella). Builds `prefixToDir` (id prefix →
   owning repo) and `basenameToDir` maps; **members claim prefixes first**
   (sampling a member's own DB via `bd list --all -n 5 --json` if a member
   resolves upward); first claim wins; umbrella's native prefix claims last.
   `defaultRepoDir` = repo containing session cwd (null at the umbrella itself).
4. **Prefix derivation from ids** (subtle, heavily tested):
   `stripIdSuffix` strips `.N` step suffixes and `-mol-…` segments;
   `ID_SUFFIX_RE = /^[0-9a-z]{1,6}$/i` distinguishes a minted suffix from a
   dashed prefix (never derives "pi" from "pi-packages"); ≥2 sampled ids use the
   **longest common prefix** (truncated at separators/partial fragments) to
   recover dashed prefixes. `dirForPrefix` = longest-prefix match.
5. **Write routing & freshness**: writes run `bd` with cwd = owning repo dir;
   `afterWrite` runs `bd export -o .beads/issues.jsonl` (umbrella mode only) and
   **always** emits `pi.events.emit("beads:changed")` (no payload);
   `ensureFresh()` runs `bd repo sync` once per dirty window before reads;
   `session_compact` resets prime + sync state.
6. **Lifecycle**: `resources_discover` → ships the bundled skill from inside the
   package; `session_start` → resolve topology + status-line segment
   (`bd✓`/`bd✗`; **no segment at all** when the DB is unusable);
   `before_agent_start` → append the prime block once (umbrella routing table +
   `Current focus: <first in_progress>` + prefer `beads_*` tools over raw bd).
7. **Startup probe economics**: exactly **one** `bd info` probe at session start;
   on failure the extension "stays quiet" (no status, no prime, tools registered
   but refusing) and topology re-resolution is lazy, single-flight, throttled to
   once per 5 s. *(This is the package's main fallback posture — see
   "New-repo considerations".)*
8. **Shared runtime for sibling extensions**: `getBeadsRuntime()` exposes
   `{ bd, dirForPrefix, afterWrite }` to cost-tracking.ts.

## The 23 tools

**Exposure policy**: every tool is `exposure: "codemode" | "deferred"` with
namespace `beads` ("Beads issue tracker — umbrella aggregate across all repos").
**Zero tools keep direct exposure.** 12 inline in codemode listings (ready, list,
show, deps, create, create_list, update, close, comment, comments, dep, undep);
11 deferred (reachable only via `searchTools()`/`ALL_TOOLS` in a codemode script):
reopen, promote, gate_create, gate_resolve, mol_pour, mol_show, mol_current,
mol_ready, memories, stale, lint. In codemode, `tools.beads_*(...)` resolves to
the **structured** payload, not the digest text.

**Undeclared-argument guard** (`guardUnknownKeys`): every write-capable tool
rejects top-level argument keys not in its declared schema, by name, listing the
accepted keys. Grounded in `docs/pi-extension-args-contract.md` (pi does not
filter undeclared keys; the guard turns a silent typo-drop into a named error).
Top-level only (nested `tasks[]` items not guarded). `jsonResult` throws if an
outputSchema tool fails to set `structuredContent`.

### Read tools (umbrella aggregate unless `repo` narrows; index views omit `description` — `beads_show` is the only body-returning tool)

1. **`beads_ready`** `{limit=15, repo, label (ALL-match), labelAny (ANY-match), claim}` →
   `bd ready --json --include-ephemeral -n <limit> …`. **Template protos stripped
   client-side** (fail-open) — the `template` label sits on the molecule root, so
   bd's own filters can't drop them. `claim:true` selects the first non-template
   row client-side (`claimHead`) and persists `bd update <id> --claim` in the
   owning repo. Known limitation: bd applies `-n` before the client filter.
2. **`beads_list`** `{status (csv), limit=30, repo, label, labelAny, mol}` →
   `bd list --json …` (`mol` adds `--all --parent <id> --include-gates`);
   normalizes bd's bare-array **or** `{issues:[…]}` envelope.
3. **`beads_show`** `{id, full?}` → `bd show <id> --json` (default truncates
   description to 240 chars); epics additionally get `bd children` and a
   `children:` line. Digest: id/status/priority/type, title, blocked_by (with
   statuses), blocks count, assignee.
4. **`beads_deps`** `{ids, direction=blockers}` — one id → `bd dep tree`
   (indented tree, `BLOCKED` prefix when a non-closed blocker exists); several
   ids → per-id `bd dep list` compact lines. Structured `{blocked, nodes}` /
   `{by_id}`.
5. **`beads_stale`** `{days=30, status (validated), limit=50}` → `bd stale --json`.
6. **`beads_lint`** `{ids, status=open|all, type}` → `bd lint … --json`; formats
   missing-sections results.
7. **`beads_comments`** `{id}` → `bd comments <id> --json`; tolerates
   author/actor, timestamp/time, body/content field aliases.
8. **`beads_memories`** `{action: remember|recall|list|forget, key, content,
   query}` — always umbrella-scoped; remember/forget are writes (emit).
9. **`beads_mol_show`** `{id}` → `bd mol show <id> --json`.
10. **`beads_mol_current`** `{id}` → `bd mol current <id> --json` (unwraps a
    top-level array to the first frame for structured output).
11. **`beads_mol_ready`** `{id, limit?}` → `bd ready --mol <id> --json`. Deliberate
    asymmetries vs `beads_ready`: does **not** strip templates (scoped to one
    molecule) and does **not** pass `--include-ephemeral`. Digest header keeps
    full counts while rows are truncated.

### Write tools (routed by id prefix; afterWrite = export + sync-dirty + `beads:changed`)

12. **`beads_create`** `{title, repo (required from umbrella root; never the
    aggregate), type=task (task|bug|feature|chore|epic|decision|spike|story),
    priority=2 (0–4, 0 highest), description, acceptance, parent (same-repo only),
    labels, notes, design, ephemeral}` — `ephemeral:true` creates a **wisp**
    (see below). Success appends ` (repo: <basename>)`.
13. **`beads_create_list`** `{parent, gate?{title="Plan reviewed / ready to
    execute", description, reason="Plan approval"}, tasks:[{title, type,
    description, acceptance, labels, priority}]}` — the plan-pour primitive:
    (1) optional gate bead `bd create --parent … --silent` then `bd gate create
    --blocks <gateId> --type human --reason …` (abort-before-tasks on failure,
    nothing partial); (2) **sequential awaited** creates so ids come out
    `parent.1..N` in plan order; (3) blocks-chain wired in **one bulk
    `bd dep add --file <jsonl>`** (temp dir, always cleaned): every task → gate,
    task i+1 → task i (`from=dependent, to=blocker` — direction pinned by an
    independent oracle test). Partial failures report exactly what was minted and
    still run afterWrite. Returns `gate:`/`human-gate:`/`t1..tN:` lines.
14. **`beads_update`** `{id, status, priority, title, parent (empty string
    removes; cross-repo rejected), notes, appendNotes, addLabels, removeLabels,
    claim, setMetadata (csv, one `--set-metadata` per pair), description, type,
    acceptance}` — "nothing to update" guard when only id given.
15. **`beads_close`** `{ids (csv, may span repos), reason, continue, suggestNext,
    claimNext, noAuto}` — per-repo `bd close`; **never cascades** (closes exactly
    the ids passed; the cascade was deliberately removed); blocked-refusal
    rewriting: strips bd's `--force` hint (no force param exists) and replaces it
    with a `blockedRemedy` naming `beads_gate_resolve({ id: "<blocker>" })` when
    the blocker is a gate; parses partial successes (`Closed <id>` lines) so mixed
    batches report `closed …` **and** `warning: …`; `claimNext` = client-side
    `bd ready --json --include-ephemeral -n 50` (template-stripped) + `claimHead`;
    failures become warnings, never silent "no next". One emit per changed repo.
16. **`beads_reopen`** `{ids, reason}` — per-repo; failures accumulate; later
    repos still attempted.
17. **`beads_dep`** `{issue, blocker, type=blocks (blocks|tracks|related|
    parent-child|discovered-from)}` → `bd link`; cross-repo rejected with an
    explicit message.
18. **`beads_undep`** `{issue, blocker}` → `bd dep remove` (no type flag).
19. **`beads_comment`** `{id, text}` → `bd comment` in owning repo.
20. **`beads_gate_create`** `{blocks, type=human (human|timer|gh:run|gh:pr),
    reason, timeout, awaitId}` → `bd gate create`.
21. **`beads_gate_resolve`** `{id}` → `bd gate resolve` (bd already closes the
    gate) + `bd dep list --direction up` to find the gated steps and **close each
    one** (emit per close); lookup failure reported honestly ("resolved but could
    not look up gated step"), never false success.
22. **`beads_mol_pour`** `{proto, vars (csv key=value), repo}` — the guarded pour:
    - **Workspace guard**: `resolveWorkspaceKey` = `git rev-parse --show-toplevel`
      → realpath → `workspaceKey()` (sha256 of normalized path, first 12 hex;
      trailing slashes/whitespace stripped; golden vectors in
      `scripts/fixtures/workspace-key-vectors.json`). Probes
      `bd list --type molecule --label ws:<key>`; unfinished molecules (closed
      roots skipped) → **rich refusal**: root id, linked bead, done/total, each
      step with raw bd status, a **resume point** from `bd mol current`
      (current_step else next_step, with degraded shapes distinguished), and
      "Ask the user: carry on / clear it and pour fresh (`bd delete <root>
      --cascade --force`)". Also surfaced via `ctx.ui.notify` so a human sees it.
      A **failed probe is not empty** — pours with a loud "poured without the
      duplicate guard" note.
    - **Step-label stamping**: re-runs `bd mol pour --dry-run`, parses
      `- <title> (from <proto>.<key>)` into ordered steps + gate map, matches
      titles against `bd mol show` issues (exactly one non-gate match required);
      ambiguity/miss → hard fail, **no partial labels** ("root is UNLABELED; do
      not use"); stamps `bd update --add-label step:<key>` on every step/gate
      (16 in the superpowers-workflow fixture) and `ws:<key>` on the root only.
23. **`beads_promote`** `{id, reason?}` → `bd promote` — wisp → permanent bead,
    id and links preserved.

### Slash commands (human-facing; output never reaches model context)

- `/beads` — board: in_progress + ready (template-stripped) via `ui.notify`.
- `/beads-sync` — `bd repo sync` at the umbrella (or "single-repo mode" note).
- `/beads-init` — `bd init --skip-agents --skip-hooks` (must not write
  AGENTS.md/CLAUDE.md/.claude/.codex/.agents or set hooksPath), then re-resolve.
- `/beads-mode` — live routing view: mode, paths, default create repo, repo list,
  prefix→folder routes, all 23 tool names.

## Wisp / ephemeral support (the fork's founding feature)

`beads_create.ephemeral` → `bd create --ephemeral` = a **wisp**: worked like any
bead, excluded from federation sync by default (`federation.exclude_types =
[wisp]`), purged wholesale once closed (`bd mol wisp gc` / `bd purge --force`).
`beads_promote` makes one permanent (id preserved). Reads include wisps
(`--include-ephemeral` in ready/board/claimNext). Design:
`2026-08-26-pi-beads-ephemeral-design.md`.

## Events & cross-extension surface

- **`beads:changed`** (pi event bus, no payload) after every successful mutating
  call — consumed by the pi-superpowers-plus molecule widget (leading-edge + 10 s
  trailing coalescing) and cost-tracking.
- **`subagents:completed` / `subagents:failed`** — consumed by cost-tracking.
- **Cost-tracking** (`src/cost-tracking.ts`, separately registered extension):
  on top-level subagent settle, reads a `bead: <id>` token from the agent's
  description, skips cleanly when absent/no cost/unknown prefix; per-bead
  **serialized read-modify-write queues** (concurrent beads run in parallel);
  writes only `cost.*` metadata keys via one `bd update` with many
  `--set-metadata` pairs — per-agent lines (`cost.agents.<sanitizedId>.total`
  (6 dp), `.tokens.input/output/cacheRead`, `.role`, `.status` — resumed
  same-id agents overwrite their own line) plus recomputed rollups
  (`cost.total`, `cost.tokens.*`, `cost.agents.count`). Errors to stderr, never
  thrown. Independent of pi-subagents' display settings.

## The bundled skill (`skills/beads/SKILL.md`) — operating doctrine

Ships inside the package via `resources_discover`. Key doctrine: umbrella =
aggregate reads + per-repo writes, **never reorganize across repos**; all tools
are codemode/deferred — call from codemode scripts; **reads are an index,
`beads_show` is the body**; don't shell out to raw `bd` or read
`.beads/issues.jsonl` directly; create in the right repo (never the aggregate;
`repo` required from the umbrella root); deps within one repo (cross-repo
ordering goes in prose); close when done, before reporting; `beads_ready({claim:
true})` is the one-call claim; typical flows (triage, capture-into-epic, wisp,
link/annotate, finish) written out as codemode examples.

## Config / env

- **`PI_BEADS_ROOT`** — the only user-facing knob (umbrella dir; `~` expanded;
  no fallback to a cwd DB when set).
- Test-only fixture protocol env vars (`FAKE_BD_*`) double as the documented
  fake-bd contract (mode/log/transient markers/canned bodies).
- No settings file; everything else derived at session start.

## Test coverage (6 suites, ~2,900 lines total)

1. **pi-beads.test.mjs** — a PATH-shadowing shell fixture `bd` that logs every
   argv; pins: exactly 23 tools; exact argv per tool; topology modes (dashed
   prefixes, collision where a member resolving upward must not steal the
   umbrella prefix; LCP prefix recovery; env-root vs cwd-only); startup-probe
   economics; `beads:changed` emitted by writes only; template stripping
   (fail-open); claim semantics; close semantics (never cascades, blocked
   refusal remedy, mixed batches, per-repo independence, claimNext warnings);
   create_list (sequential order via concurrency marker, bulk-dep oracle,
   gate-abort, partial failures); gate_resolve honesty; mol_pour (16-step
   stamping, refusal detail incl. degraded `bd mol current` shapes, closed
   molecules never refuse, failed-probe pours loudly); lock retry through the
   real runner; workspaceKey goldens; unknown-repo error text.
2. **lock-retry.test.mjs** — regexes, budgets, classification, exhaustion text,
   with injectable sleep.
3. **cost-tracking.test.mjs** — exact `--set-metadata` argv; accumulation;
   resume overwrite; skip matrix; failed events record spend; same-bead
   serialization; single registration across factory runs.
4. **tool-surface.test.mjs** — docs-as-contract: README/SKILL/pi-tools.md must
   enumerate every tool and field; create-only fields never on update;
   non-vacuity guards.
5. **tool-exposure.test.mjs** — 23 tools, zero direct, exact 12/11 codemode/
   deferred split as literals (a tool can't silently move between sets).
6. **packaging.test.mjs** — npm packlist import-walk: every transitively
   imported module is packed; the real tarball's entry points import and export
   a default function.

## New-repo considerations

1. **The quiet-startup fallback is the big [decide] Q2a/Q2b item**: today, bd
   missing / `.beads/` absent → extension goes quiet, tools refuse, lazy retry.
   A no-fallback stack likely wants: fail loudly at session start (status
   `bd✗` + notification, or refuse session), no quiet mode, no lazy retry.
2. `beads_mol_pour`'s `git rev-parse --show-toplevel` dependency is one of the
   two VCS couplings (see 02 §2) — under jj it needs an explicit root resolution
   (and a loud failure rather than silent cwd fallback).
3. The `lock-retry.ts` duplication with pi-superpowers-plus's
   `dolt-lock-retry.mjs` is deliberate (no cross-package imports); in a new repo,
   either keep the duplication rule or extract a shared internal module
   (**[decide] Q4**).
4. Tool-surface/tool-exposure/packaging tests are the model for keeping docs and
   manifests honest — cheap to port, high value.
5. If Q11/Q12 lean toward pane-based UI, the status-line segment and `/beads`
   board may be redundant with a pane-rendered board — but they are cheap and
   in-context-visible; keep-or-drop is a brainstorming call.
6. **pi-rex runs pi-beads in single-repo mode** (Q8 decision 2026-11-02:
   independent per-repo databases, no umbrella) — the umbrella machinery
   (prefix routing, LCP recovery, export/sync hydration, the multi-repo prime
   block) goes dormant, and the bundled skill's doctrine should be written
   single-repo-first for pi-rex. The umbrella capabilities stay in the code
   (tested, dormant) in case the model ever changes.
7. bd version pin: the tool pins against **bd 1.2.2** output parsing; the new
   repo should pin/verify the bd version at startup (another candidate for
   fail-loud instead of parse-drift).
