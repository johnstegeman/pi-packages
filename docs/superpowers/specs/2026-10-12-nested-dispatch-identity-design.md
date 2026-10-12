# The nested dispatch result carries its child's durable id

Molecule: `pi-packages-mol-faoae` · Bead: `pi-packages-9ghce` (P3, bug)

Date: 2026-10-12 · Status: approved design (`review.verdict=done` on `pi-packages-mol-t18g3`)

## Problem

`pi-packages-jnr7.5` gave every **top-level** `Agent` dispatch result an `Agent ID:` / `Handle:`
block (`identityLines`, `src/index.ts:2023`). The **nested** paths did not.
`src/nested-tools.ts:191` (nested resume) and `:358` (nested foreground spawn) both render through
`formatRecord(record, "inline")`, which emits the outcome note and the child's output and nothing
that names the child.

So a parent that spawns a child through its scoped `Agent` tool receives the child's output and no
way to refer to it: it cannot fill a ledger's `agent:` field, cannot `get_subagent_result` it, and
cannot resume or steer it. A nested child *is* reachable through the nested tool set
(`resume`, `get_subagent_result`, `steer_subagent` are all ownership-scoped and id-based) — the
parent simply has no id to pass.

This was left open deliberately, not overlooked. The jnr7.5 spec recorded two relevant facts:

- §1: "The `Handle:` line is omitted when the record carries no handle (nested children)."
- Out of scope: "Nested and workflow-owned agents (resume remains top-level only)."

`src/agent-manager.ts:509-511` states the boundary: nested and workflow-owned children are "filtered
out of every top-level surface, so no handle: nothing can address them and they must not consume a
name a top-level sibling could otherwise take". `tombstone()` returns early for them
(`:1459-1460`), so they leave no tombstone and cannot be reopened after eviction.

Because this is a change to that boundary rather than to a formatter, the bead posed it as a
decision with two arms: surface the child's id, or document the unaddressability as intentional.

## Evidence: the scenario has never occurred

The decision was made on evidence, gathered from every session log on this machine
(`~/.pi/agent/sessions`: 3235 session files, 2866 of them subagent sessions).

| Signal | Count |
|---|---|
| Nested `Agent` calls ever made by a subagent | 24 |
| — of those, with `resume:` | 0 |
| — of those, `run_in_background: true` | 0 |
| Nested `get_subagent_result` calls | 0 |
| Nested `steer_subagent` calls | 0 |
| Real tool results ever containing `Nested agent not found or not owned by this parent` | 0 (all 12 raw matches were source-code reads, not tool output) |
| Real tool results ever containing `Failed to resume nested agent` | 0 (all 7 were reads too) |
| `resume:` on a *top-level* `Agent` call | 100+, including `task-…-impl` handles — the jnr7.5 scenario |

All 24 nested calls share one shape: a `task-reviewer` or `code-reviewer` subagent dispatching a
single **foreground `Explore`** for a bounded lookup, reading the answer, and never referring to the
child again. Both templates declare `allowed_subagents: Explore`, so a nested *implementer* resume
is not reachable from the agents that actually use nesting. The SDD fix loop that motivated jnr7.5
runs at the top level, where the id is already surfaced.

**Conclusion:** no caller has needed this. It is closed as a gap, not as a bug fix — the id is
surfaced so that a nested caller *can* name its own child, and the boundary that made this a
decision is preserved rather than widened.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Surface the id at all | **Yes** | No real-world occurrence, but the gap is real and the fix is two lines; the alternative (a README note that nested children are unaddressable by design) leaves a parent unable to name work it owns |
| Handle | **Id only** — no handle, no alias, no tombstone for nested children | Handles are the `@handle` mention namespace and share `takenHandles()`; giving nested children one changes the boundary at `agent-manager.ts:509-511` for no evidenced need |
| Placement | **Mirror the top-level order**: note/headline → `Agent ID:` → blank line → output | Same shape as `index.ts:2424-2430`; keeps the rule at `nested-tools.ts:136-137` that the note must precede the output; one `Agent ID: (\S+)` regex serves a controller at either level |
| `queued` / `running` branch | **Unchanged** | It already prints `Agent <record.id> is <status>.` |
| Fetched (`get_subagent_result`) position | **Unchanged** | The parent supplied that id as an argument; echoing it is noise |
| Background nested ack (`Nested agent started in background. Agent ID: …`, `:347`) | **Unchanged** | A dispatch acknowledgement, not a result; already names the id |
| Where the helper lives | **`src/identity.ts`**, imported by both entry points | One definition instead of two that can drift; `status-note.ts` is the tested precedent for a helper both entry points need |
| Skill prose (`pi-superpowers-plus`) | **No change** | The review agents' nested `Explore` is a one-shot lookup with no ledger |

## §1 — Extract `identityLines` into `src/identity.ts`

New module, the same shape as the package's other small shared modules (`xml.ts` is 13 lines,
`child-context.ts` 15):

```ts
// LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md (Divergence 9)
/**
 * The two identity lines a dispatch result carries: the durable record id, and
 * the handle the spawn actually assigned when the record has one.
 */
export function identityLines(record: { id: string; alias?: string; handle?: string }): string {
  const handle = record.alias ?? record.handle;
  return `Agent ID: ${record.id}\n` + (handle ? `Handle: ${handle}\n` : "");
}
```

`src/index.ts` deletes its module-private copy (`:2014-2026`, marker included — the marker moves
with the helper) and imports the function alongside its existing `./status-note.js` import. All
eight call sites (`:2103`, `:2124`, `:2165`, `:2183`, `:2188`, `:2272`, `:2412`, `:2426`) are
unchanged: Divergence 8 already established that the helper carries the marker and its call sites do
not.

The helper is pure — it captures nothing from `index.ts`'s closure — so this is a move, not a
refactor.

**Why a new file rather than appending to `status-note.ts`:** that module is named for and scoped to
status/outcome wording, and the two have different lifetimes (identity survives a clean completion,
where the note is empty). `status-note.ts`'s own header rationale — "both entry points need it …
[neither] can import from index.ts" — is the precedent being followed, not the file being extended.

## §2 — `formatRecord` emits the id on the inline position only

`src/nested-tools.ts:128-143`, after the change:

```ts
function formatRecord(record: AgentRecord, position: ResultPosition): string {
  // LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md (Divergence 9)
  // Inline only: a fetched result was asked for BY id, so the caller already
  // holds it and echoing it is noise. A nested record carries no handle, so
  // identityLines emits the id line alone.
  const identity = position === "inline" ? identityLines(record).trimEnd() : "";
  if (record.status === "error") {
    return `Agent failed: ${record.error ?? "unknown error"}${partialOutputSuffix(record)}` +
      (identity ? `\n${identity}` : "");
  }
  if (record.status === "queued" || record.status === "running") {
    return `Agent ${record.id} is ${record.status}.`;
  }
  const text = record.result?.trim() || record.error?.trim() || "No output.";
  const note = position === "inline"
    ? getForegroundOutcomeNote(record.status)
    : getStatusNote(record.status);
  const head = [note ? `Nested agent${note}.` : undefined, identity || undefined]
    .filter((line): line is string => line !== undefined);
  return head.length > 0 ? `${head.join("\n")}\n\n${text}` : text;
}
```

Resulting shapes:

| case | before | after |
|---|---|---|
| clean, inline | `<output>` | `Agent ID: 1a84899d-…\n\n<output>` |
| `steered` / `aborted` / `stopped`, inline | `Nested agent (note).\n\n<output>` | `Nested agent (note).\nAgent ID: 1a84899d-…\n\n<output>` |
| error, inline | `Agent failed: <err><partial>` | `Agent failed: <err><partial>\nAgent ID: 1a84899d-…` |
| `queued` / `running` | `Agent <id> is <status>.` | unchanged |
| any fetched (`get_subagent_result`) | — | unchanged |

The note still leads the output in every case where it appears, which is the property the comment at
`:136-137` protects. No trailing newline is introduced anywhere, so nested results keep their current
"no trailing whitespace" property. Both inline call sites (`:191` nested resume, `:358` nested
spawn) pick this up with no change of their own.

Because nested records carry neither `handle` nor `alias`, the `Handle:` line is omitted **by
construction** rather than by comment — the rule jnr7.5's spec stated, now enforced by the shared
helper.

## §3 — Docs

**`docs/pi-subagents-local-patch.md`** — a new
`## Divergence 9 — the nested dispatch result carries its child's id (pi-packages-9ghce)`.
Divergence 8's item 1 describes `identityLines` as "one module-private helper"; rather than rewrite
that PR's historical record, Divergence 9 states that the helper now lives in `src/identity.ts` and
is shared with the nested formatter, and names `src/nested-tools.ts` as its first
`LOCAL PATCH`-marked site. The "In-code marker convention" paragraph gains the same clause.

**`packages/pi-subagents/README.md`**, two clarifications so the new behaviour does not read as a
contradiction:

- `:212` — "Nested subagents are not addressable" becomes "…are not addressable **by `@handle` from a
  top-level session**…". The rule that a handle naming one starts a fresh top-level agent is
  unchanged; what is added is that a parent names its own child by the id its dispatch result
  reports.
- `:343` — after "Nested records remain internal to that parent and do not appear in top-level
  tools, lifecycle events, or agent UI", add: a nested dispatch result carries the child's
  `Agent ID:` line, so its parent can name it to `resume` / `get_subagent_result` / `steer_subagent`
  for as long as the record is live; nested children get no `Handle:` line, because handles belong to
  the top-level `@handle` namespace.

No `pi-superpowers-plus` prose change: the review agents' nested `Explore` is a one-shot lookup with
no ledger, and their `allowed_subagents: Explore` allowlist means a nested implementer resume is not
reachable from them.

## §4 — Tests

**`packages/pi-subagents`** (gate: `npm run check`; vitest). Added to `test/nested-tools.test.ts`:

1. clean inline completion → the result begins `Agent ID: child-1\n\n` and the child's output
   follows.
2. `steered` inline → the exact string `Nested agent (wrapped up at the turn limit — everything the
   agent produced is above; the task may be unfinished).\nAgent ID: child-1\n\nhalf an answer`
   (extends the existing truncation test at `:399`).
3. error inline → the result ends `\nAgent ID: child-1`.
4. **the fetched position carries no id** → `get_subagent_result` on the same record has no
   `Agent ID:` line.
5. the nested `resume` path (`:191`) carries the id too.
6. a nested record with neither `handle` nor `alias` emits no `Handle:` line — pinning id-only as
   behaviour rather than as an accident of the record shape.

`test/foreground-result-retrieval.test.ts` is **untouched**; that is the bead's third acceptance
criterion. `test/nested-delegation-e2e.test.ts` and `test/subagents-nested-print-mode-e2e.test.ts`
keep passing unchanged (they assert on the child's output text, which is still present).

## §5 — Packaging and verification

- One branch, one PR to `main`, touching `packages/pi-subagents` and
  `docs/pi-subagents-local-patch.md`.
- Verification: `node scripts/ci/package-gate.mjs pi-subagents` and root `npm test`, both under the
  pinned toolchain (`mise exec node@22`). No dependency changes, so no lockfile churn.

## Out of scope

- Handles, aliases or tombstones for nested children — the mention namespace and `takenHandles()` are
  untouched.
- Any change to the fetched (`get_subagent_result`) or background-ack result shapes.
- Any change to the top-level dispatch contract.
- Skill prose in `pi-superpowers-plus`.
- Persisting nested records across the eviction window or a session switch.

## Acceptance criteria mapping

| `pi-packages-9ghce` AC | Where satisfied |
|---|---|
| A nested caller can obtain its child's durable id from the child's result | §2 — the inline spawn and the nested resume |
| If ids are surfaced, the ownership-scoping rules are unchanged: a parent still reaches only its own children, and nested records stay out of every top-level surface | §2 — the id is emitted into a result only the owning parent receives; no record, handle, tombstone or top-level surface changes |
| No change to the top-level contract pinned by `packages/pi-subagents/test/foreground-result-retrieval.test.ts` | §1 is a pure move; that file is not edited |

## Risks

1. **A child's own output could contain the string `Agent ID:`.** It already could; the id line is
   now guaranteed to be the first line of a clean inline result and the line directly after the note
   otherwise, which makes an anchored parse safer than an unanchored search. No new exposure: the
   nested result is delivered to the owning parent and nowhere else.
2. **The helper move touches `index.ts`,** the file the package's whole suite exercises. Mitigated by
   the helper being pure and by `test/foreground-result-retrieval.test.ts` pinning the top-level
   shapes it renders — that file is deliberately not edited, so it is a real regression test for the
   move.
3. **A reader may mistake the new line for upstream behaviour.** Mitigated by the `LOCAL PATCH`
   marker at the edit site and Divergence 9 in the local-patch record.
