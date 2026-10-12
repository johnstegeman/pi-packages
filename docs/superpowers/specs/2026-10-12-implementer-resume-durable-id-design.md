# Implementer resume across the eviction window: the durable-id contract and a resume that reopens from disk

Molecule: `pi-packages-mol-ny2w3` · Bead: `pi-packages-jnr7.5` (P2)
(epic `pi-packages-jnr7` — its last open success criterion)

Date: 2026-10-12 · Status: approved design (`review.verdict=done` on `pi-packages-mol-5zt0m`)

## Problem

The subagent-driven-development fix loop resumes the original implementer for rounds 1-3 so
its context stays intact. A tool-bound controller cannot do that, and the loop silently
degrades to a fresh implementer every time.

Three mechanisms produce the failure, and all three are still true at HEAD:

1. **The record is evicted.** `AgentManager.cleanup()` (`agent-manager.ts:1478`) removes any
   non-running record older than `10 * 60_000` ms, via `removeRecord` → `tombstone()` +
   `agents.delete(id)`.
2. **`resume` reads the live map only.** The Agent tool's resume branch
   (`index.ts:2002-2009`) calls `manager.getRecord(params.resume)`, which is
   `this.agents.get(id)` (`agent-manager.ts:1340`). Once evicted: `Agent not found:
   "task-…-impl". It may have been cleaned up.` `manager.resume` (`:1109`) additionally
   requires `record.session`, which `removeRecord` has already detached (`:1442`). The
   lookup also takes an exact **id**, so even a *live* handle does not work.
3. **The durable id is never surfaced.** A foreground `Agent(...)` result carries only
   `Agent completed in … (<stats>).` plus the agent's output text — the id rides in
   `details.agentId` (`index.ts:240`), which the codemode string drops. `get_subagent_result`
   echoes the *queried* alias back as `structuredContent.agentId`
   (`index.ts:3084`), never the resolved `record.id`.

Observed cost, from the bead and its comment: task reviews of 251 s, 566 s and 199 s, with
~8 minutes elapsed from the implementer finishing to the resume attempt in the last case —
the ~10-minute window is not the only thing that has to fit, the review itself does.
`reference/recovery.md:3` documents the eviction and admits the only post-eviction channel
is a typed `@task-…-impl` mention, "and a tool-bound controller cannot type mentions".

The machinery to reopen an evicted conversation **already ships** — for mentions. The
`@handle` path (`index.ts:972-1036`) resolves a tombstone and reopens the conversation from
disk with `spawnResolved(..., { resumeSessionFile: entry.sessionFile, reclaim: { handle,
alias } })`. The defect is that `resume` does not use it.

## Constraints (what must not change)

1. **The 10-minute eviction window stays.** The tombstone already outlives it; the timer
   exists to bound memory (`agent-manager.ts:390-395`), not to expire a conversation.
2. **Tombstone lifetime stays session-scoped** — ≤ `MAX_TOMBSTONES` (100) handles, cleared on
   `/new` and session switch. No new persisted store; the ledger remains the documented
   cross-session recovery map.
3. **`steer_subagent` stays live-only.** A tombstone has nothing to steer.
4. **Resume stays top-level only**, as today (`index.ts:2004`); nested and workflow-owned
   children are filtered out of every top-level surface.
5. **The gated path is untouched.** `fix-loop.js`'s within-round child resume is immediate and
   never spans the window; its `resume: 'fix'` semantics do not change.
6. **The reopen is not a stored-result read.** `get_subagent_result` never spawns; only an
   explicit `resume` does.

## Design decisions (resolved in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| End-state | **Both** — surface a durable id *and* make `resume` reopen from disk | The reopen machinery already exists for mentions, so the incremental cost is small; a durable id is needed regardless to fill the ledger's `agent:` field. |
| Primary resume key | **The handle** (`task-<sanitized-task-id>-impl`); the id recorded alongside | The handle is re-derivable from the task bead id, so it survives controller compaction with nothing copied out of a result. The id stays as the precise record. |
| Durability boundary | **The live session** (record + tombstone lifetime) | The failure that bit was ~8 minutes inside one session; the fix loop never spans a session switch; a persisted store is a new mechanism for a case the design can name and document instead. |
| Where the reopen lives | **Inside `Agent({ resume })`**, as a resolution ladder | One entry point; the fix loop's call site is unchanged; no new prose fork for the controller to get wrong. |
| Genuinely-gone case | **Try, then fall back, and record it** | The round absorbs the failure; the ledger line is what stops it being silent. |
| `get_subagent_result` on a tombstone | **Identity only** — `agentId`, `status: "evicted"`, reopen hint; no spawn | Closes "or a query" at zero cost; keeps "reopen costs a run" on `resume`, which is asking for work anyway. |
| Dispatch result | **Echo the resolved handle** alongside the id | Kills the `-impl-2` stale-handle trap at the source: the controller can only record what it was actually assigned. |
| Reopened resume reporting | **Result says so, and the round line records it** | "Reopened from disk" is the cheap version of the same silence this bead exists to end. |

## 1. The durable-id contract

Per implementer, two keys, both written to the ledger's dispatch line:

| field | value | property |
|---|---|---|
| `agent:` | `record.id` (opaque, `randomUUID().slice(0, 17)`) | precise and unambiguous, but must be copied out of a result |
| `handle:` | `record.alias ?? record.handle` | re-derivable from the task bead id; may carry a `-impl-2` suffix |

**Surfaced where:**

- **Foreground `Agent(...)` result text** (`index.ts:2295`) gains the identity block the
  background path already prints, as two added lines on **both** the success return and the
  `Agent failed:` return — the controller should never have to guess whether it holds an id:
  `Agent ID: <record.id>` and `Handle: <record.alias ?? record.handle>`. The `Handle:` line is
  omitted when the record carries no handle (nested children).
- **Background `Agent(...)` results** (`index.ts:2145` for a spawn, `:2041` for a resume)
  already print `Agent ID: <id>`; they gain `Handle: <…>` for symmetry.
- **`get_subagent_result`** — `structuredContent.agentId` becomes the **resolved**
  `record.id` (today it echoes the queried alias, `index.ts:3097`), and the payload gains a
  resolved `handle`. The tool's `outputSchema` (`index.ts:2947`) therefore gains an optional
  `handle` field. The prose line already prints `Agent: <record.id>`.
- **The `resume` parameter's own description** (`index.ts:1655`) and the Agent tool guideline
  that names it (`index.ts:1534`) — both currently say "an agent ID" — are updated to say the
  parameter accepts an id **or** a handle and reopens an evicted conversation from disk. The
  description is the only place the model learns the parameter's contract.

**For how long:** identity is obtainable while the record is live (until the ~10-minute
cutoff) and while its tombstone survives (≤ 100 handles, cleared on `/new` and session
switch). Past both there is no identity to obtain, and §4 says what the loop does about it.

## 2. The resume resolution ladder — `Agent({ resume: <ref> })`

`ref` resolves in order, stopping at the first hit. Rungs 1 and 2 preserve today's
behaviour; rung 3 is new; rung 4 replaces the bare failure.

1. **Live record, exact id** — `manager.getRecord(ref)`, top-level check. Unchanged.
2. **Live record, by handle or alias** — `manager.resolveMention(ref)` returning
   `kind: "live"`. New, and the reason the ledger's `handle:` is usable as the resume key.
3. **Tombstone, by handle, alias or id** — `resolveMention` returning `kind: "tombstone"`,
   then **reopen from disk**.
4. **Nothing** — a named error (§2.3).

`resolveMention` (`agent-manager.ts:1367`) already implements the ordering: a live record
that matches wins (preferring one still steerable), and only then is a tombstone consulted —
"a tombstone is a conversation to reopen, and reopening one while its record still exists
would fork the session."

### 2.1 Rung 3 — the reopen

Mechanically identical to the mention path (`index.ts:972-1036`), which is the tested
precedent:

```
existsSync(entry.sessionFile)                       // else: drop the tombstone, §2.3 case (a)
reloadCustomAgents()
const dispatch = resolveSpawnType(entry.type)       // refuse when !ok || fellBackFrom !== undefined
spawnResolved(pi, ctx, dispatch.type, prompt, {
  description: entry.description,
  reclaim: { handle: entry.handle, alias: entry.alias },
  resumeSessionFile: entry.sessionFile,
  isBackground,
})
await manager.awaitStartup(id)
```

`spawnResolved` — not `spawnTopLevel` — because the latter strips `resumeSessionFile` and
`reclaim` as untrusted; both come from a tombstone this extension wrote. `reclaim` hands the
reopened record the names the tombstone was holding, so the handle keeps resolving to the
same *conversation* even though the record id is new.

### 2.2 Guards the reopen must inherit

A reopen is a **spawn**, so it does not get `manager.resume`'s checks for free. It must:

- reject nested/non-top-level refs, as today (`isTopLevelAgent`);
- refuse when a live record by that ref is `running` or `queued`, keeping the existing
  message ("it can only be resumed once its current run finishes… use `steer_subagent`");
- honour `run_in_background` — a background reopen takes a background pool slot and queues
  exactly like a background spawn;
- accept that the reopened record is a **new record with a new id**, its status reset, its
  `completedAt` cleared.
- ignore `subagent_type` entirely and take the type from the tombstone's `entry.type`,
  matching today's resume, where the parameter is required by the schema but unused
  (`index.ts:1812`);
- leave the existing `resume` incompatibilities (`schedule`, `inherit_context`) unchanged.

### 2.3 Errors — rung 4, and the two tombstone failures

Both cases name the working alternative, which is the whole point of the message.

| case | message (shape) |
|---|---|
| tombstone present, session file gone | `Agent "<ref>" was evicted and its session file is gone; the conversation cannot be reopened. Re-dispatch a fresh implementer with the report file.` — and **drop the tombstone** (`dropTombstone`), since a row that can only ever fail is worse than none |
| no live record, no tombstone | `Agent not found: "<ref>" — no live record and no evicted conversation by that name in this session. If it was dispatched in an earlier session, re-dispatch with the report file.` |
| live record, still running | unchanged today's message |

The current bare `Agent not found: "<ref>". It may have been cleaned up.` never appears
again for a ref that has a tombstone.

### 2.4 Result text names the rung

- live resume: unchanged (`record.result` + `details`).
- **reopened**: `Agent resumed from disk (record evicted; new Agent ID: <id>; handle:
  <handle>).` followed by the run's output — so the controller can tell a continuous context
  from a reconstructed one, and record which happened.

## 3. `get_subagent_result` — identity from a tombstone

`resolveAgentRef` (`index.ts:750`) resolves live records only; it stays that way for
`steer_subagent`. `get_subagent_result` gains a tombstone branch that answers **identity
without spawning** — placed where the live lookup already runs, ahead of the `wf_…` run-id
branch (`index.ts:2973-2981`), so a tombstoned handle wins the lookup exactly as a live one
does:

- `structuredContent`: `{ agentId: entry.id, status: "evicted" }` — the durable id, resolved
  from the tombstone, not the queried alias.
- prose: the record's `Agent: <entry.id>` / type / description lines, plus
  `This agent's record was evicted; its conversation is still on disk and can be reopened
  with Agent({ resume: "<handle>" }). The stored result is not kept — see the report file.`
- `wait: true` on an evicted agent returns immediately (there is nothing to wait for);
  `verbose` has no conversation to render and is ignored.

`steer_subagent` is unchanged: a tombstone has nothing to steer.

## 4. Skill contract changes (`pi-superpowers-plus`)

Four prose files; **no script changes**.

- **`SKILL.md` §1 (Dispatch the implementer)** — "Record the implementer's agent ID from the
  `Agent(...)` dispatch result" becomes: record **both** `agent:` and `handle:` from the
  result, and note that fix-loop rounds 1-3 resume by the **handle**.
- **`reference/fix-loop.md` (Rounds 1-3)** — the resume call becomes
  `Agent({ subagent_type: "implementer", resume: "<handle>", prompt: "<open findings
  verbatim>" })`, with the reason stated (the handle is re-derivable after compaction; the id
  is not, and the handle is what the dispatch result reports). Two ledger forms join the
  existing ones:
  - reopened: `… commits <a7>..<b7> — implementer resumed from disk`
  - failed: `Task <N>: fix round <R>/5 — resume failed (<cause>); re-dispatched fresh
    implementer with the report file`, after which the round continues under the existing
    rounds-4-5 framing ("A prior implementer attempted this task; you own it now — read the
    report file").
- **`reference/dispatch-implementer.md`** — the canonical-handle bullet is reframed: the
  dispatch result now **echoes the resolved handle**, so the ledger records what was actually
  assigned. The `-impl-2` warning stays, demoted from "you cannot know" to "the canonical
  name is a derivation — trust the surfaced handle; prefer the recorded `agent:` id when you
  need the exact record".
- **`reference/recovery.md`** — corrects two now-false claims: that `get_subagent_result`
  resolves live records only (it answers identity from a tombstone), and that after eviction
  the only channel is a typed `@handle` (a tool-bound `resume` reopens from disk). The
  ~10-minute window and the session boundary are restated as the **identity** boundary, not
  the recovery boundary.

## 5. Tests

**`pi-subagents`** (gate: `npm run check`; vitest; existing files
`test/agent-manager.test.ts`, `test/agent-manager-gc.test.ts`, `test/foreground-result-retrieval.test.ts`
are the natural homes):

- **Ladder**: resume by live id; by live handle; by tombstone handle → asserts a **new**
  record with the reclaimed handle and the resumed session file; nothing → the rung-4 message.
- **Guards**: a `running`/`queued` ref is refused with the existing message; a nested ref is
  rejected; `run_in_background` on a reopen queues when the pool is full.
- **Eviction/tombstone** (`agent-manager-gc.test.ts`): an evicted record is reopenable; a
  missing `sessionFile` drops the tombstone and yields the "unrecoverable" error; a session
  switch clears it — pinning the documented boundary.
- **Identity surfacing**: a foreground `Agent(...)` result text carries `Agent ID:` **and**
  `Handle:`; two dispatches under one name pin `…-impl-2` in the second result.
- **`get_subagent_result`**: a tombstoned handle returns `agentId === entry.id`,
  `status: "evicted"`, and **spawns nothing** (asserted against the manager).

**`pi-superpowers-plus`** (gate: `npm run check && npm test`): structural pins in the existing
`test/skills-contract.test.mjs` style — `fix-loop.md` names the handle as the resume key and
carries both new ledger forms; `SKILL.md` §1 requires both fields. No behaviour test for
prose, per the package's existing style.

## 6. Packaging and verification

- One branch, one PR to `main`, touching both packages:
  `feat(pi-subagents): resume an evicted agent from disk and surface the durable id` (with the
  skill-prose changes in the same PR, since the contract is split across the two).
- Verification: `node scripts/ci/package-gate.mjs pi-subagents`,
  `node scripts/ci/package-gate.mjs pi-superpowers-plus`, and root `npm test`, all under the
  pinned toolchain (`mise exec node@22`). No dependency changes, so no lockfile churn.

## Acceptance criteria mapping

| `pi-packages-jnr7.5` AC | Where satisfied |
|---|---|
| A design is brainstormed and a spec committed under `docs/superpowers/specs/` | this document |
| The spec decides the durable-id contract (what is surfaced, where, and for how long) | §1 |
| The spec states what the fix loop does when the implementer is genuinely gone, so the degradation stops being silent | §2.3 (tool message) + §4 (ledger line) |

Epic `pi-packages-jnr7` criterion — "A fix round either resumes the original implementer, or
the skill documents the degradation and the controller can obtain a durable agent id for an
implementer it dispatched": satisfied on **both** branches. The resume succeeds across the
window (§2), the controller obtains the id from the dispatch result and from a query (§1,
§3), and the residual degradation is named in the ledger (§4).

## Out of scope

- Any change to the 10-minute eviction cutoff, or to `MAX_TOMBSTONES`.
- Persisting tombstones (or records) across sessions or restarts.
- `steer_subagent` semantics for evicted agents.
- The gated `fix-loop.js` path and its within-round child resume.
- Nested and workflow-owned agents (resume remains top-level only).
- Changing how handles are assigned — the `-impl-2` collision behaviour is deliberate (a live
  or resumable agent must not lose its name); the fix is to surface the assigned handle.

## Risks

1. **`resume` can now spawn.** Mitigated by rung ordering — a live record always wins — and by
   the result naming the rung.
2. **A reopen is a real run, not a stored read** — it costs tokens. Accepted: the caller
   explicitly asked to resume; `get_subagent_result` remains the free, read-only query.
3. **Frontmatter drift.** A reopened conversation re-resolves the *current* `implementer`
   frontmatter, and the `resolveSpawnType` fallback refusal prevents reopening under a
   different agent type. This is the behaviour the mention path already has.
4. **A hand-typed canonical handle after a fresh dispatch** can still name the older
   implementer. The surfaced handle removes the trap for a controller that records what it
   was given; the ledger line is the record.
5. **The session boundary still loses identity.** Accepted and documented (§1, §4).

## Errata (2026-10-12)

**§2.3's quoted refusal strings are not what shipped.** The code is the authority; the table was
drafted before the messages were final, and they diverge in punctuation, case and — at rung 4 —
the noun. Shipped:

- **tombstone present, session file gone** —
  `Agent "<ref>" was evicted and its session file is gone; the conversation cannot be reopened — re-dispatch a fresh implementer with the report file.`
  The design text's `. Re-dispatch` is two sentences with a capital; the shipped message keeps the
  em dash and lowercase `re-dispatch`. The drop-the-tombstone half is unchanged.
- **tombstone present, agent type unavailable** — a case the §2.3 table omits. Shipped:
  `Agent "<ref>" was evicted and the <type> agent is no longer available; its conversation cannot be reopened yet — the record is kept, so re-enabling the agent makes resume "<ref>" work again. Or re-dispatch a fresh implementer with the report file.`
  The refusal is **not** terminal: `planReopen` deliberately keeps the tombstone (`src/index.ts:813-814`),
  so re-enabling the agent restores the resume. The message says so, matching the mention path's
  keep-the-tombstone behaviour rather than reading as a dead end.
- **no live record, no tombstone** —
  `Agent not found: "<ref>" — no live record by that id or handle in this session. If it was dispatched in an earlier session, re-dispatch with the report file.`
  The design text's `no live record and no evicted conversation by that name` is the draft; the
  shipped message says `by that id or handle in this session`.
