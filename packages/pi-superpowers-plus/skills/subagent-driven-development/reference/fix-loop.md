# The fix loop

The loop triggers when the review reports spec ❌, any Critical or Important
finding, or a ⚠️ item you confirmed as a real gap.

Before the loop starts, two routes leave it immediately:

- **Every finding that is not Critical or Important is dispositioned when it is recorded** —
  fix now, drop, or defer, per [disposition.md](disposition.md). A fix-now finding rides this
  task's fix round when one is already running, and otherwise goes on the `wrap-up` list; only
  genuine defers stay there unresolved. "Parked" is not a resting state, and a roll-up nobody
  resolves is a silent discard. The list's format is defined in [disposition.md](disposition.md)
  § "Where the list lives".
- A finding labeled plan-mandated — or any finding that conflicts with
  what the task text requires — is the human's decision, like any plan
  contradiction: present the finding and the task text, ask which governs.
  Do not dismiss the finding because the plan mandates it, and do not
  dispatch a fix that contradicts the plan without asking.

Everything else enters the loop. A fix round is one fix dispatch plus one
scoped re-review. Five rounds maximum per task:

**Covering-test command known — the gated path.** When the implementer's report names a re-runnable covering-test command (or the task's package has a test script to fall back to), a fix round runs as a `SubagentWorkflow` script so the suite verifies the fix instead of prose:

```
SubagentWorkflow({ scriptPath: "<skill>/scripts/fix-loop.js", args: { taskBeadId, reportFilePath, findings, gate, fixBase, head, gateBeadId, reviewPackage } })
```

Two of those args describe heads, and they are not interchangeable. `fixBase` is the head the previous review saw — the start of the re-review range. `head` is the head at dispatch, and the script uses it **only as a label** in the re-review prompt: the round's package is built to the **runtime `HEAD`**, because the fix agent commits inside the round and a package ending at the dispatch-time head would omit the very fix the re-review exists to judge. Pass whatever the current head is; you do not need to pass a symbolic `HEAD` yourself, and passing the dispatch-time SHA is correct.

The script gates the fix agent on `gate` — a non-zero exit fails the agent and its output becomes the error — resumes the same child once on rejection (`resume: 'fix'`; `gate` and `resume` cannot combine), then re-verifies with a fresh gated call. One round = one invocation. When the gate still fails after the one resume, the script returns `{ passed: false }`: **adjudicate now** per the breaker rules below — continuing would burn guaranteed-failing rounds. The round's scoped re-review runs as the script's pipeline stage 2 (the child builds the review package itself via the `reviewPackage` path). Re-review verdicts ride back in the envelope; a `null` re-review means the controller re-runs the scoped re-review once on the prose path — never assume a clean round. Rounds ≥ 2 of a multi-round gated loop are fresh children fed the report file (the within-round resume replaces rounds 1-3's controller resume for this task). If `SubagentWorkflow` is absent (pi <0.84 / disabled / stand-down) or a `passed: false` envelope's `reason` is `'bad-args'` or the gate command itself is broken (exit 127 / "command not found"), validate the command's shape before re-running it yourself: accept only `cd <path> && <simple test command>` where the simple test command is a plain executable with args and the command contains none of `;`, `|`, `>`, `<`, `&`, `$(`, `${`, or backticks. If the command fails that shape check, DO NOT re-run it — treat the round as `passed: false` on the broken-gate path and fall back to the prose path (or substitute the task package's `npm test` as a safe alternative). Then repair or drop the gate and continue on the prose path; the fix is not at fault.

**The round never closes the bead — and you re-read it before you do.** A round leaves the task bead exactly as you claimed it (`in_progress`). Before closing it, re-read it (`beads_show`). If it is already closed, a child closed a bead it does not own: append `Task <N>: DEVIATION — bead closed by a child (<closed_at>, <close_reason>); reconciled` to the ledger and rule on it — re-open the bead, or record why the close stands and what you did to reconcile. Every workflow prompt now carries the guardrail that forbids this and every agent template repeats it, but the guardrail is advisory; this re-read is the only detection mechanism.

**No covering-test command — the prose path below is unchanged.**

**Rounds 1-3 — resume the original implementer.** Dispatch it with
`Agent({ subagent_type: "implementer", resume: <agent_id>, prompt:
"<open findings verbatim>" })`, where `<agent_id>` is the identity you
recorded when you first dispatched this task's implementer. Its context is
intact: it knows the task, the code, and its own choices. The `resume:`
parameter is real tool support from `@tintinweb/pi-subagents` — the old
"resume this agent" instruction had no tool behind it; now it does.
Keep the resumed agent's `handle:` (recorded at dispatch) in the ledger, and append it to each fix-round line: after compaction, `get_subagent_result` by the handle retrieves the finished implementer's outcome without re-dispatch. This query is safe because each fix round runs and resumes inside the live window; after eviction the ledger (commits + handle) is the cross-session record.

**Rounds 4-5 — dispatch a fresh implementer** (drop `resume:`), with the
task bead id, the report-file path, the open findings, and this framing: "A
prior implementer attempted this task [N] times; you own it now. Read the
report file for what was tried." A loop that survives three resumes usually
means the implementer cannot see its own problem — fresh eyes in one move.

**Every round, either way:** the implementer fixes, re-runs the tests
covering the amended code, appends its fix report to the same report file,
and returns the short contract. Before re-dispatching the reviewer, confirm
the fix report contains the covering tests, the command run, and the
output; dispatch the re-review once all three are present. Name the
covering test files in the fix message — a one-line fix does not need the
whole suite. On the gated path the "confirm the fix report contains the
covering tests, the command run, and the output" check is superseded —
the script's gate result is the test evidence; on the prose path it
applies as written.

**The re-review is scoped.** Run `scripts/review-package <implement-step-id> FIX_BASE HEAD`
where FIX_BASE is the head the previous review saw, and dispatch
[re-review-prompt.md](../re-review-prompt.md) with the findings list, the
task bead id, the report file, and the printed diff path. The re-reviewer verdicts
each finding ADDRESSED or NOT ADDRESSED and flags new breakage in the fix
diff only. New Critical/Important breakage in the fix diff joins the open
findings list. Out-of-scope observations are dispositioned per [disposition.md](disposition.md) — they never
extend the loop.

**After each round,** append to the ledger:
`Task <N>: fix round <R>/5 (<X> addressed, <Y> open — <finding one-liners>; commits <a7>..<b7>)`

Gated rounds use one of these instead: `Task <N>: fix round <R>/5 gated: <cmd> passed — <X> addressed, <Y> open; commits <base>..<head>`, and on a failed gate `Task <N>: fix round <R>/5 GATE FAILED (<cmd>) — <output tail>; <ruling>`. `passed: false` rulings use the existing breaker entries unchanged (parked / deferred / `Task <N>: BLOCKED — <reason>`).

Never fix findings yourself in the controller session — your context stays
clean for coordination, and controller fixes skip review.

**The breaker.** When round 5's re-review still leaves findings open, stop
dispatching. Adjudicate each open finding yourself — you hold the plan and
the cross-task context the reviewer lacks:

- **The reviewer is wrong, or the point is contestable:** park it —
  `Task <N>: parked — <finding> — ruling: <why the code stands>`. The final
  review sees both sides. The ruling *is* the record-time decision; the item goes on the ledger's
  `wrap-up` list, where the outcome is applied — dropped there if the ruling holds, or put to the
  human as a defer. Parking is not filing: do not create a bead for it here.
- **Real, but nothing downstream builds on it:** park it the same way, with a ruling that says it
  is real. The ruling *is* the record-time decision; the item goes on the ledger's `wrap-up` list,
  where the outcome is applied — fixed there, dropped, or put to the human as a defer. Parking is
  not filing: do not create a bead for it here.
- **Real and load-bearing** — a later task builds on it, or it reveals a
  plan defect: STOP. Append `Task <N>: BLOCKED — <reason>` and report to
  your human partner with the finding, the task text it collides with, and
  the fix history. Parking a structural failure lets every dependent task
  build on it and hands the final review a problem it cannot fix either.

Adjudicate only at the cap. Adjudicating earlier to end a loop is
pre-judging with a different name. Every adjudication is a ledger entry —
a silent discard is forbidden.
