---
name: brainstorming
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."
disable-model-invocation: true
---

> **Related skills:** Consider `/skill:using-git-worktrees` to set up an isolated workspace, then `/skill:writing-plans` (run `/plan`) for implementation planning.

# Brainstorming Ideas Into Designs

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design and get user approval.
At the start of the skill, call `set_phase({ phase: "brainstorming" })`.
<HARD-GATE>
**STOP — set up tracking before you do anything else.** Before you read any files, run
any commands, or explore the project in any way (Step 1 below), you must pour the workflow
molecule and put the widget on screen:

- **Fresh topic:** cook and pour the workflow formula, then note the returned root issue id
  (the `Root issue:` line) — this is the molecule you work against for the rest of this
  skill and for `writing-plans`/`executing-plans` afterward:

  ```bash
  bd cook superpowers-workflow --var topic="<topic>" --persist
  beads_mol_pour({ proto: "superpowers-workflow", vars: "topic=<topic>" })
  ```

- **Existing epic** (e.g. "brainstorm beads-kp0"): this gate still applies — an existing
  issue does NOT release you from pouring. Pour a NEW molecule as above, seeding
  `--var topic="<existing issue's title>"`, then link the new root to the existing issue
  without mutating it:

  ```
  beads_dep({ issue: "<new-root-id>", blocker: "<existing-issue-id>", type: "discovered-from" })
  ```

  If `discovered-from` is rejected by your `bd` version, use `--type related` instead —
  both are non-blocking link types; do not use `blocks`. Never change the existing issue's
  type, parent, or status — it stays exactly what it was.

- **Show the widget immediately after pouring:** run `beads_mol_current({ id: "<root-id>" })`
  (and `beads_mol_ready({ id: "<root-id>" })`) so the user sees the live current step
  before any exploration begins.

Step 0 is **not complete until the widget is actually visible** — calling `bd cook` /
`beads_mol_pour` alone is not enough. **Do not begin Step 1 until Step 0 is complete.**
</HARD-GATE>

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

<HARD-GATE>
Brainstorming spans many conversation turns, not one. Each checklist item below is real work, not a formality to wave through. Specifically:
- "Ask clarifying questions" is not satisfied by asking one question. Keep asking, one per turn, across as many real turns as it takes, until you actually understand purpose/constraints/success criteria — and stop after each question to wait for the user's actual reply.
- Never answer your own question on the user's behalf, assume what they "probably" meant, or draft the rest of the checklist (approaches, design, doc) in the same turn as the question. Each checklist item is completed in its own turn(s), grounded in what the user actually said.
- Do not mark a checklist item — or the overall brainstorming phase — complete until its real output exists in the conversation: an approved design section, a written+committed spec file, or explicit user sign-off. Marking items complete ahead of that work, or moving on to `writing-plans`/execution because the checklist "looks done," is the failure mode this gate exists to prevent.
</HARD-GATE>

## Boundaries
- Read code and docs: yes
- Write to docs/superpowers/specs/: yes
- Edit or create any other files: no

> **Read now:** [reference/anti-patterns.md](reference/anti-patterns.md) — the three anti-patterns (too simple, rushing the checklist, peeking at the repo). Read before starting the checklist.
## Checklist

**Step 0 — Pour the workflow molecule and show the widget (MANDATORY — see the STOP gate at the top of this skill).** Do this before anything else; the full commands and the existing-epic branch live in that gate. Step 0 is complete only when `beads_mol_pour` **and** `beads_mol_current` have both been called **and** the widget is visible on screen. This applies even when an existing epic already tracks this work — pour a NEW molecule, link it via `discovered-from` (`--type related` if rejected), and leave the existing issue untouched.

**Do not begin Step 1 below until Step 0 is complete.**

Each checklist item from Step 1 on corresponds to one formula step. Claim the step when you begin
it (`beads_update({ id: "<step-id>", claim: true })`), work it, and close it (`beads_close({ ids: "<step-id>", reason:
"<one-line summary>" })`) only once its real output actually exists in the conversation (see
the hard-gate above) — never close several in a row within the same turn. Step ids in
this molecule: `explore`, `clarify`, `approaches`, `design`, `design-approved` (a gate —
see After the Design below), then `write-spec`/`spec-review`/`spec-approved` continue
into spec work, handed off to `writing-plans` at `implement`. Resolve each step id at
runtime via `beads_list({ label: "step:<key>", mol: "<root-id>" })` — e.g. `step:explore`,
`step:clarify`, `step:design`, `step:write-spec`; gates are `step:gate-<key>` (e.g.
`step:gate-design-approved`).
Close each step bead in the same turn its real output exists (never batch several closes at the end of a phase) — this is what keeps `bd mol current --json` honest so the widget shows the real current step.
**When you claim step N+1, close step N you just completed in the same turn** — this general rule applies to every handoff between consecutive steps above, not just the specific pairs called out below (e.g. approaches→design).

1. **Explore project context** (`beads_update({ id: "<explore-step-id>", claim: true })`) — check files, docs, recent commits in the **user's current working directory** (not the skill's install directory — see `using-superpowers` → Working Directory). Close with `beads_close({ ids: "<explore-step-id>" })` once done.
2. **Ask clarifying questions** (`beads_update({ id: "<clarify-step-id>", claim: true })`) — one at a time, across as many turns as it takes, waiting for the user's actual reply each time, until you understand purpose/constraints/success criteria. Do not close this step after a single question.
3. **Propose 2-3 approaches** (`beads_update({ id: "<approaches-step-id>", claim: true })`) — with trade-offs and your recommendation
4. **Present design** (`beads_update({ id: "<design-step-id>", claim: true })`) — in sections scaled to their complexity, get user approval after each section. **When you claim the design step, close the approaches step in the same turn — never move forward leaving the previous step open.**
5. **Write design doc** — save to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and commit
6. **Spec self-review** — quick inline check for placeholders, contradictions, ambiguity, scope (see below)
7. **User reviews written spec** — ask user to review the spec file before proceeding
8. **Transition to implementation** — print `/plan` for the user to run; the user types it to load the writing-plans skill and create the implementation plan

## After the Design

**Documentation:**

- Write the validated design (spec) to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
  - (User preferences for spec location override this default)
- Commit the design document to git
> **Read now:** [reference/verdict-recording.md](reference/verdict-recording.md) — resume, changes-requested, and gate-resolve edge cases. Read before recording the design verdict.
- After presenting the design, record the verdict on the `design-approved` step so a
  resumed session or the widget can see it without replaying the conversation:
  - Approved: `beads_update({ id: "<design-approved-id>", setMetadata: "review.verdict=done" })`,
    then resolve the gate so `write-spec` becomes ready:
    `beads_gate_resolve({ id: "<design-approved-gate-id>" })` (find the gate id via
    `beads_list({ label: "step:gate-design-approved", mol: "<root-id>" })`).
  - Changes requested: `beads_update({ id: "<design-approved-id>", setMetadata: "review.verdict=iterate" })`,
    then write a specific revision summary and loop back into the design presentation —
    do NOT resolve the gate. The full procedure and edge cases are in the read-gate above.

**Spec Self-Review:**
After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick one and make it explicit.

Fix any issues inline. No need to re-review — just fix and move on.

**User Review Gate:**
After the spec review loop passes, ask the user to review the written spec before proceeding:

> "Spec written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start writing out the implementation plan."

Wait for the user's response. If they request changes, make them and re-run the spec review loop. Only proceed once the user approves. **When you claim the spec-approved step, close the spec-review step in the same turn — never move forward leaving the previous step open.**

**Implementation:**

- Print `/plan` for the user to run — the user types it, loading the writing-plans skill via pi expansion, to create a detailed implementation plan
- Do NOT invoke any other skill. writing-plans is the next step.


## Reference material

- [reference/anti-patterns.md](reference/anti-patterns.md) — the three anti-patterns: too simple, rushing the checklist, peeking at the repo.
- [reference/process-flow.md](reference/process-flow.md) — the brainstorming process-flow diagram and the terminal hand-off state.
- [reference/process-guidance.md](reference/process-guidance.md) — elaboration on understanding the idea, exploring approaches, design for isolation, and working in existing codebases.
- [reference/verdict-recording.md](reference/verdict-recording.md) — design-verdict edge cases: changes requested, resume, gate-resolve, and close ordering.
