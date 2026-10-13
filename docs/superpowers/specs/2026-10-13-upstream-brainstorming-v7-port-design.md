# Port upstream superpowers v7.0.0 brainstorming (and writing-plans) into pi-superpowers-plus

**Status:** approved (2026-10-13); implemented (2026-10-13)
**Scope:** `packages/pi-superpowers-plus` — `skills/brainstorming/`, `skills/writing-plans/`, `formulas/superpowers-workflow.formula.toml`
**Upstream:** `obra/superpowers` v7.0.0 (released 2026-10-10) — PRs #2463, #2482, #2483, plus the writing-plans rework in the same release

This document is a **decision-ready port plan**. It changes no skill text itself. `/plan` turns it into an implementation plan; the drafted text below is illustrative and the implementation plan makes it authoritative.

---

## 1. Context

### 1.1 What upstream changed

Upstream rebuilt `skills/brainstorming/SKILL.md` from scratch (#2463, 2,613 words → ~1,500) around *drawing out intent*, then added two follow-ups (#2482, #2483) about which implementation choices the human wants to own. The same release reworked `skills/writing-plans/SKILL.md`.

Upstream's stated motivation: the skill had drifted from drawing out intent toward routing and gating. Intent got one paragraph whose default move was "ask one focused question about purpose", which doesn't work on people. Measured on the pre-rewrite skill: 25/25 openings led with process jargon, 20/20 non-trivial openings were lettered menus, 16–27 menu options per conversation, and "make the app icon cornflower blue" became a 70–150-word design plus "Should I go ahead?" in 5/5 runs. After the rewrite: 0/25 jargon openings, 0–1 menu options per conversation, cornflower blue handled as a quick task 5/5, and 6/6 blind testers preferring the new skill. (Evidence: the upstream intent doc `docs/superpowers/specs/2026-10-05-brainstorming-rebuild-design.md`, PR #2463's body, and the eval results in PR #2464.)

**The change in one sentence:** the skill now draws out what the human actually wants before it proposes anything, then sizes the work to match — instead of classifying the request up front and running a fixed gated process.

### 1.2 Where this fork actually sits

This is the part that determines the port's shape, and it is easy to get wrong:

- The local `brainstorming` skill is derived from **upstream v6.2.0**, not v6.4.x. It still has the v6.2.0 checklist (`explore → clarify → approaches → design → write-spec → spec-review → spec-approved → implement`), which upstream's v6.4.x "Three Paths" router had already replaced and which v7.0.0 replaced again.
- **The v6.4.x router was never ported**, so there is no spike/bounded/architectural text to remove. The v7.0.0 rewrite lands on a cleaner base than a naive diff suggests.
- On top of the v6.2.0 text, the fork added **seven local mechanisms** (listed in §1.3), which is why local `SKILL.md` is 10.6 KB against upstream's old 2.5 KB.
- Local `writing-plans` is adapted much more heavily than `brainstorming`: its plan output is **beads, not a document**, so it has no plan file at all.

### 1.3 The seven local mechanisms

Confirmed as **defaults to justify, not fixed constraints** — the plan may recommend changing or dropping any of them, with reasoning.

| # | Mechanism |
|---|---|
| 1 | Step 0 — mandatory molecule pour + visible widget before any exploration |
| 2 | Per-step claim/close (`beads_update` / `beads_close`), step labels, close-N-when-claiming-N+1 |
| 3 | Gates — `design-approved`, `spec-approved` via `beads_gate_resolve`; `review.verdict=done\|iterate` metadata |
| 4 | `reference/` split with read-gates, so `SKILL.md` stays a lean decision tree |
| 5 | `disable-model-invocation: true` + the `/brainstorm` command alias |
| 6 | `/plan` handoff — print the command, never invoke `writing-plans` itself |
| 7 | `set_phase({ phase: "brainstorming" })` at skill start |

### 1.4 The beads tool surface (a constraint discovered during design)

pi-beads exposes exactly four molecule tools: `beads_mol_pour`, `beads_mol_show`, `beads_mol_current`, `beads_mol_ready`. **There is no `beads_mol_bond` and no `beads_mol_squash`**, and the repo's convention (a deliberate recent commit) is `beads_*` tools over raw `bd`. This rules out the elegant sizing mechanisms and is why §6.1 resolves the way it does.

The formula schema *does* support a `condition` field (`bd formula schema Step`) — "makes this step optional based on a variable", evaluated at cook/pour time — which becomes relevant only if the pour is moved after the sizing decision (§6.1, alternative A2).

---

## 2. Decision: Approach C — two layers

**Adopt upstream's conversation architecture as the skill's prose, and express the beads mechanics as a separate, self-contained tracking section rather than weaving them through the conversation instructions.**

### 2.1 Why this and not the alternatives

**Approach A — re-base on upstream text, re-layer the tracking inline.** Highest fidelity, lowest future sync cost. Rejected because it puts the tracking layer back *inside* the conversation flow, which is precisely what makes local diffs expensive to re-read on the next sync — and because it forces a full formula step-id re-map anyway, so it buys less than it appears to.

**Approach B — graft upstream behaviors onto the local checklist.** Smallest blast radius; formula, tests, and widget largely untouched. Rejected because it preserves the exact shape upstream's rewrite was written to destroy: routing-and-gating-first, with intent squeezed into a step. The #2463 eval evidence is evidence against that shape, and keeping it keeps local at 1.4x+ upstream forever.

**Approach C (chosen).** Upstream's prose stays diffable against upstream; the local mechanics stay auditable in one place; the skill lands near upstream's size plus a bounded tracking section instead of 1.4x. Cost: it is the largest single change to the formula and the molecule-widget contract, so it wants its own test pass, and the two layers can drift if a future sync touches a hooked section — which is what §3's mapping table makes checkable.

### 2.2 Recorded as follow-ups, not folded in

- **Bonded two-formula sizing** — a conversation-half formula plus a delivery-half formula, bonded at the sizing decision via `bd mol bond`. Cleanest widget, but requires a new `beads_mol_bond` tool in pi-beads. Revisit if close-as-skipped (§6.1) proves noisy.
- **Extension-driven tracking** — move the beads layer out of skill prose entirely, into an extension reacting to phase/skill events. Would shrink `SKILL.md` below upstream's size, but trades prose the agent reads for machinery nobody can audit in the skill text. Bigger project than this port.

---

## 3. Upstream → local mapping table

### 3.1 Rules

- **Every section of every upstream source appears exactly once.** No upstream section may be dropped by omission.
- **Every `drop` row carries a reason.**
- Dispositions are drawn from a closed set: `adopt verbatim`, `adopt reworded`, `adapt` (behavior kept, text rewritten for the local flow), `drop — visual companion`, `drop — superseded`, `drop — harness-specific`, `drop — out of scope`, `already absent (no-op)`.

> **Note on the disposition set.** §2 of the design discussion presented six dispositions. Two were added while writing this spec and are called out rather than smuggled in: `drop — harness-specific` (used once, for upstream's "say a reviewer will read it first" sentence — §6.2) and `already absent (no-op)` (used once, for the `plan-document-reviewer-prompt.md` deletion — §8). Both are `drop`-family dispositions and both carry reasons, so the two rules above still hold.

### 3.2 Source 1 — `skills/brainstorming/SKILL.md` @ v7.0.0 (#2463)

| Upstream section | Disposition | Local destination | Notes |
|---|---|---|---|
| frontmatter `name` | adopt verbatim | frontmatter | `brainstorming` |
| frontmatter `description` | adopt reworded | frontmatter | keep upstream's "You MUST use this before any creative work… in software or out of it" strength; add local `disable-model-invocation: true` (mechanism 5) |
| `# Brainstorming` intro | adopt verbatim | `# Brainstorming` | the "you build what you believe your human partner wants" framing is the point of the rewrite |
| `## First: What Do You Actually Know?` | adopt verbatim | same | doubles as the pour gate (§6.1) |
| `## Your First Message` | adapt | same | one inline hook added: the opt-out path still states the how-it-gets-made choice and records no molecule (per #2483) |
| `## The Conversation` → "Each message ends with one question" | adopt verbatim | same | |
| `## The Conversation` → "Be clear and concise…" | adopt verbatim | same | |
| `## The Conversation` → **Get them describing.** | adopt verbatim | same | |
| `## The Conversation` → **How it gets made.** | adopt verbatim | same | the #2482/#2483 addition; see §3.3 |
| `## The Conversation` → **Ground to cover.** | adopt verbatim | same | territory-not-script list |
| `## The Conversation` → **Questions that work** | adopt verbatim | same | |
| `## The Conversation` → **Offer recon.** | adopt verbatim | same | this is where local's `explore` step folds in (§7) |
| `## The Conversation` → **Think wide privately.** | adopt verbatim | same | this is where local's `approaches` step folds in (§7) |
| `## The Conversation` → **Show, don't tell.** + bullet list | **drop — visual companion** | — | no visual companion in pi |
| `## The Conversation` → **Spike to feel things out.** | adopt verbatim | same | kept; interacts with the hard gate's spike exception |
| `## Play It Back` ¶1–2 (chunks, guesses marked, alternate with questions) | adopt verbatim | same | this is where local's `design` step folds in |
| `## Play It Back` ¶3 (visual companion offer before sending a chunk) | **drop — visual companion** | — | |
| `## Size the Work` (table + growth + decomposition) | adapt | same | one inline hook added: this is the branch that decides the molecule's fate (§6.1) |
| `## The Written Design` → content list | adopt verbatim | same | intent+why, goals/non-goals/anti-goals, constraints, the how they decided, what's left to the builder |
| `## The Written Design` → **Where it goes** | adopt verbatim | same | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, committed; user preference overrides |
| `## The Written Design` → **Builder check** | adapt | same | becomes the content of the `spec-review` step; dispatch mode left to `/plan` (§6.2) |
| `<HARD-GATE>` | adapt | `<HARD-GATE>` | upstream's text with local gate #2's "applies to EVERY project regardless of perceived simplicity" wording folded in |
| `## Red Flags` table | adopt verbatim | same | 5 rows, all still applicable |
| `## Visual Companion` (all of it: intro, offer, per-question rule, accept path) | **drop — visual companion** | — | ~6 rows collapsed here for brevity; the implementation plan should enumerate each sub-paragraph so the excision stays auditable |
| `skills/brainstorming/spec-document-reviewer-prompt.md` (deleted upstream) | **already absent (no-op)** | — | local never had this file; the deletion needs no action |
| `skills/brainstorming/builder-check-prompt.md` (added upstream) | adopt verbatim | `skills/brainstorming/builder-check-prompt.md` | contains no visual-companion content, so it needs no excision; byte-identical keeps the next sync a copy rather than a merge |
| `docs/superpowers/specs/2026-10-05-brainstorming-rebuild-design.md` (added upstream) | **drop — out of scope** | — | cited as evidence in §1.1, not ported |

### 3.3 Source 2 — #2482 / #2483 (how it gets made)

| Upstream change | Disposition | Local destination | Notes |
|---|---|---|---|
| New **How it gets made.** paragraph (medium/tools/materials; which choices they own vs. hand over; existing work; any choice you make goes in the design as your call, never as something they agreed to) | adopt verbatim | `## The Conversation` | the substance of #2482 |
| #2483 gap 1 — the opt-out path must still state any significant how-it-gets-made choice in one plain line | adapt | `## Your First Message` hook | one added clause; without it the opt-out silently reproduces the exact failure #2482 was written to fix |
| #2483 gap 2 — drop the duplicated "which of those choices they want to make" instruction (already a **Ground to cover** bullet) | adopt verbatim | `## The Conversation` | pure dedup; the **Ground to cover** bullet is the survivor |

### 3.4 Source 3 — `skills/writing-plans/SKILL.md` @ v7.0.0

| Upstream section / change | Disposition | Local destination | Notes |
|---|---|---|---|
| `## Overview` reworded (engineer who hasn't seen this codebase or spec; assume idiomatic code once interface and test are known; document what *you* decided) | adopt verbatim | `## Overview` | replaces local's "zero context / questionable taste / assume they don't know good test design". Load-bearing: the rest of the skill is incoherent without it |
| `## Scope Check` | adopt verbatim | unchanged | already identical |
| `## File Structure` | adopt verbatim | unchanged | already identical, including the existing-codebase bullet |
| `## Task Right-Sizing` | adopt verbatim | unchanged | already identical |
| `## Step Granularity` (was `## Bite-Sized Task Granularity`; "one action with a checkable result", no "2-5 minutes") | adopt verbatim | rename local section | |
| `## Plan Document Header` | adapt — optional | plan-approval gate bead description | no plan file to head; Goal/Architecture/Tech Stack/Spec-path are optional plan-level metadata — §8.3 finding 5 |
| `## Global Constraints` | adapt | **plan-approval gate bead description — already implemented** | the fork already authors this block there (`reference/creating-task-beads.md`); only upstream's *content rule* needs adopting — §8.3 finding 1 |
| `## Review Focus` | adapt | plan-approval gate bead description (new) | the list lives once at plan level; each line's **test** goes into the owning task — §8.3 finding 4 |
| `## Task Structure` example — Step 3 becomes a signature + one line on approach | adapt | `reference/task-template.md` | local's template carries the code-block form today |
| `## What a Step Contains` (new; replaces `## No Placeholders`) | adopt reworded | new section + `reference/red-flags.md` | **inverts** the local red-flags catalog — see §8.2 |
| `## Self-Review` item 2 "Placeholder scan" → "Step scan" | adopt verbatim | `## Self-Review` item 2 | points at `reference/red-flags.md` |
| `## Self-Review` item 4 "Review Focus" | adopt verbatim | `## Self-Review` item 4 | inserted verbatim after item 3; the local lifecycle-duplicate check is renumbered to item 6 |
| `## Self-Review` new item 5 "Proportion" | adopt verbatim | `## Self-Review` item 5 | |
| `skills/writing-plans/plan-document-reviewer-prompt.md` (deleted upstream) | **already absent (no-op)** | — | local never had this file |
| `## Execution Handoff` | **drop — superseded** | local `## Execution Handoff` kept as-is | upstream's handoff assumes a plan file and an execution-choice prompt; local's is beads-based with a `plan-approved` gate. Local version wins |

### 3.5 Local-only content → destination

Not upstream sections, but they must be accounted for or they vanish silently.

| Local content | Destination |
|---|---|
| `> **Related skills:**` note | keep, reworded (brainstorming now hands off at a *size* decision, not always to `/plan`) |
| `> **Reaching beads tools:**` note | keep verbatim in `SKILL.md` and in each `reference/` file that makes beads calls |
| local HARD-GATE #1 (Step 0 pour + widget) | absorbed into `## Tracking This Session`; pour becomes conditional (§6.1) |
| local HARD-GATE #2 (no implementation before approval) | merged into upstream's `<HARD-GATE>` |
| local HARD-GATE #3 (brainstorming spans many turns; don't rush the checklist) | **kept, shortened** — it guards against the tracking layer's own incentive to batch step closes, which upstream's prose does not address |
| `## Boundaries` (read yes / write specs yes / nothing else) | reworded as a size-keyed table (§4) |
| `## Checklist` (8 numbered steps) | **superseded** by upstream's narrative sections; the step list moves into `## Tracking This Session` |
| `## After the Design` (documentation, verdict recording, spec self-review, user review gate, implementation) | split: verdict recording → `## Tracking This Session`; spec self-review → `write-spec`'s close reason (§6.2); user review gate → upstream's builder-check + approval flow; implementation → local `/plan` handoff |
| `reference/anti-patterns.md` | rewrite — anti-pattern #1 contradicts sizing (§4.5) |
| `reference/process-flow.md` | rewrite the graph for the new flow (§4.5) |
| `reference/process-guidance.md` | re-derive; most of it is upstream-deleted text (§4.5) |
| `reference/verdict-recording.md` | keep; one amendment for `spec-review`'s new meaning (§6.2) |

---

## 4. Target `brainstorming/SKILL.md` shape

Upstream's conversation spine, unchanged in order, with one section inserted after the intro.

| Target section | Origin | Action |
|---|---|---|
| frontmatter | local + upstream | upstream description widened to upstream's non-software wording (a talk, a business, a renovation); keep `disable-model-invocation: true` |
| `> Related skills:` note | local | reworded |
| `# Brainstorming` | upstream | verbatim |
| `## Tracking This Session` | **local, new** | the whole beads mechanism, self-contained — drafted in §5 |
| `## First: What Do You Actually Know?` | upstream | verbatim; also the pour gate |
| `## Your First Message` | upstream | verbatim + one opt-out hook |
| `## The Conversation` | upstream | verbatim, minus **Show, don't tell**; **Spike to feel things out** kept |
| `## Play It Back` | upstream | verbatim, minus the closing visual-companion paragraph |
| `## Size the Work` | upstream | verbatim + one tracking hook |
| `## The Written Design` | upstream | verbatim; builder check fills `spec-review` |
| `<HARD-GATE>` | merged | upstream gate + local "every project regardless of perceived simplicity" |
| `## Red Flags` | upstream | verbatim |
| `## Boundaries` | local | reworded as a size-keyed table (§4.4) |
| `## Reference material` | local | index of `reference/` files |

### 4.1 The three local HARD-GATEs collapse

- **Gate #1 (Step 0)** → the tracking layer's own instruction, conditional on size. Its purpose survives in a stronger form: under upstream's flow nothing is explored before the first message, so "pour before you explore" becomes "pour before you say anything".
- **Gate #2** → merged into upstream's gate (which already covers "Building includes writing product code, scaffolding, installing dependencies, creating projects, and invoking an implementation skill").
- **Gate #3 (many turns)** → **kept, shortened.** Rationale: it is a guard against the tracking layer's own incentive — the step checklist invites batching closes — not against upstream's text. Upstream's narrative ("Each message ends with one question", playback alternating with questions) largely encodes the rest.

### 4.2 Drafted: the gate merge

```markdown
<HARD-GATE>
Nothing gets built until your human partner approves the full
description: in chat for a small change, the document for a project.
Building includes writing product code, scaffolding, installing
dependencies, creating projects, and invoking an implementation skill.
Reading and exploring are fine. This applies to EVERY project regardless
of perceived simplicity.

Two exceptions. If they opted out of the questions, the skill is done and
the gate goes with it. A spike they said yes to may be built; it stays
labeled throwaway, and keeping what it produced is a new request that
comes back through this gate.

After a project's document is approved, the next step is the plan. For
software, print `/plan` for your human partner to run — it loads the
writing-plans skill via pi's native skill expansion. Do not invoke any
other skill.
</HARD-GATE>
```

The last paragraph is the local mechanism-6 adaptation: upstream says "invoke superpowers:writing-plans and no other skill"; pi hands off by printing the command.

### 4.3 Drafted: the kept third gate

```markdown
<HARD-GATE>
Brainstorming spans many conversation turns, not one. Each tracking step
is real work: claim it when you begin, close it when its output actually
exists in the conversation. Never close several in a row within one turn,
and never treat a step as done because the checklist "looks" finished.
The failure this guards against is batching step closes to make the widget
look complete.
</HARD-GATE>
```

### 4.4 Drafted: size-keyed boundaries

```markdown
## Boundaries

| Size | Read code and docs | Write to `docs/superpowers/specs/` | Edit anything else |
|---|---|---|---|
| A quick, clear task | yes | no | no — do the work itself |
| A small change | yes | no (the description lives in chat) | no — build it through the normal workflow once approved |
| A project | yes | yes | no |
```

Replaces the current flat "read yes / write specs yes / nothing else", which is wrong for the first two sizes.

### 4.5 The four `reference/` files

| File | Action | Detail |
|---|---|---|
| `anti-patterns.md` | **rewrite** | Anti-pattern #1 ("This Is Too Simple To Need A Design — every project goes through this process… a config change… all of them") directly contradicts sizing. Rewrite to "too simple to need a *document*": the approval still applies, the paperwork doesn't. Anti-pattern #2 (rushing the checklist) stays, reworded for the new step names. Anti-pattern #3 ("let me just peek at the repo first") has a premise that inverts — rewrite it as "pour before you speak", not "pour before you explore" |
| `process-flow.md` | **rewrite** | The graph encodes `explore → clarify → approaches → design → approve → write → self-review → user-review → /plan`. New flow: `pre-check → [quick task \| first message → conversation ↔ playback → size → [small change \| document → builder check → approve]] → /plan`. The terminal-state note (print `/plan`, never invoke `writing-plans`) stays |
| `process-guidance.md` | **re-derive** | Most of it is text upstream deliberately deleted: no "Design for isolation and clarity", no "Working in existing codebases", no "YAGNI ruthlessly", no process-flow diagram, no numbered checklist. "Working in existing codebases" survives upstream in `writing-plans` §File Structure — **link, don't copy**. Isolation prose should be marked as a local addition, not presented as upstream-derived. YAGNI survives in `writing-plans`' Overview |
| `verdict-recording.md` | **amend** | `spec-review`'s close now asserts the builder check *returned and its questions were sorted*, not that a self-review happened (§6.2). Everything else (changes-requested loop, resume, gate-resolve/close ordering) is unchanged |

---

## 5. The tracking layer (drafted)

Placed after the intro, before `## First: What Do You Actually Know?`.

```markdown
## Tracking This Session

Work at **small change** and **project** size runs against a beads molecule,
so the step you are on is visible in the widget and survives a resume. A
**quick, clear task** does not: there is no molecule, no widget, and no step
bookkeeping — do the work and say what you did.

**Pour before you speak.** Once the private check says something non-trivial
is missing, pour the workflow formula before you send your first message:

  beads_mol_pour({ proto: "superpowers-workflow", vars: "topic=<topic>" })

Note the root issue id from the `Root issue:` line — it is the molecule you
work against for the rest of this skill and for `writing-plans` /
`executing-plans` afterward. Then show the widget immediately:

  beads_mol_current({ id: "<root-id>" })
  beads_mol_ready({ id: "<root-id>" })

**Reaching beads tools:** every `beads_*` tool has `codemode`/`deferred`
exposure, so none is in your tool list. Call them from a `codemode` script —
`await tools.beads_update({ ... })` — and find the deferred ones with
`await searchTools("beads")`. The call shapes here are that script's
arguments.

**Working the steps.** Each step below is one formula step. Claim it when you
begin, close it once its real output exists in the conversation. Resolve step
ids at runtime with
`beads_list({ label: "step:<key>", mol: "<root-id>" })`.

| Step | Close it when |
|---|---|
| `conversation` | you have drawn out intent — questions, playback, and any recon your partner asked for are one continuous phase |
| `playback` | your partner has corrected your playback and you agree on the description. **Record the size in the close reason** (`size: project` / `size: small change`) |
| `design-approved` | your partner approved the full description — in chat for a small change, by reading the document for a project |
| `write-spec` | the document is written and committed, and the four-point self-review is clean. **Project size only** — for a small change, close this and the two steps below as skipped: `"small change: description agreed in chat"` |
| `spec-review` | the builder check returned and its questions were sorted (§ The Written Design) |
| `spec-approved` | your partner has reviewed the document and answered the "theirs" pile |
| `implement` | leave open — it represents the whole implementation phase |

**When you claim step N+1, close step N in the same turn.** This applies to
every handoff between consecutive steps, not just the pairs called out above.
Closing on time is what keeps `bd mol current --json` honest so the widget
shows the real current step.

**Gates.** `design-approved` and `spec-approved` each carry a human gate.
Record the verdict on the step, then resolve the gate so the next step becomes
ready:

- Approved: `beads_update({ id: "<step-id>", setMetadata: "review.verdict=done" })`
  then `beads_gate_resolve({ id: "<gate-id>" })` — find the gate via
  `beads_list({ label: "step:gate-design-approved", mol: "<root-id>" })`.
- Changes requested: `beads_update({ id: "<step-id>", setMetadata: "review.verdict=iterate" })`,
  then comment a specific revision summary and loop back. Do NOT resolve the gate.

> **Read now:** [reference/verdict-recording.md](reference/verdict-recording.md) —
> resume, changes-requested, and gate-resolve edge cases.
```

**Two drafting notes for `/plan`:**

1. The `write-spec` row encodes the §6.1 resolution (close-as-skipped). If the plan prefers an explicit `size` step, that row and §7 change together.
2. The step table's middle column is prose, not commands — the plan should keep it that way, since the current skill's over-specification of close mechanics is part of what made it long.

---

## 6. The two hard cases

### 6.1 Sizing vs. Step 0

**The collision.** Upstream's headline behavior is that "make the app icon cornflower blue" is a quick task: do it, say what you did. Local's headline is a mandatory 17-step molecule pour before anything else. They cannot both be unconditional.

**Resolution — three parts:**

1. **The pre-check gates the pour.** Upstream's `## First: What Do You Actually Know?` is a private, exploration-free check, so it can run before anything is poured. "Everything that matters is in the request" → no molecule at all. Anything non-trivial → pour, then send the first message.
2. **The pour therefore happens earlier than today, not later.** Today's gate says "before you read any files, run any commands, or explore the project in any way". Under upstream's flow there is no exploration before the first message, so pouring at the pre-check satisfies the gate's purpose in a stronger form.
3. **A small change closes the document steps as skipped.** The three-way size is only known *after* the conversation, so a single unconditioned pour is the only mechanism available without new beads tools (§1.4). When the size resolves to "small change", `write-spec`, `spec-review`, and `spec-approved` close with reason `"small change: description agreed in chat"`.

**Why close-as-skipped rather than the alternatives:**

| Option | Mechanism | Verdict |
|---|---|---|
| **A1 (chosen)** | one formula, poured at pre-check; document steps closed-as-skipped on small changes | No new machinery; widget present from the first message through the whole conversation (where resume-safety matters most); reads honestly in `bd mol show` — those steps were considered and skipped, not silently absent. Cost: ~3 closed-as-skipped steps on a small change |
| **A2** | one formula with `condition` on the document steps, poured at the *size decision* | Clean step list, no skipped steps — but no widget during the conversation, which is the longest phase, and the fork's largest investment (Step 0 + the widget extension) exists precisely to cover it. Rejected |
| **B** | two formulas bonded at the size decision | Cleanest widget, but needs a new `beads_mol_bond` tool in pi-beads. Recorded as a follow-up (§2.2) |
| **C** | one formula, `bd mol squash` on small changes | Needs a new tool, and throws away the small change's tracking. Rejected |

**The honest cost, stated plainly:** a small-change session shows roughly three steps closed-as-skipped. That is bookkeeping, not work, and the widget already renders closed steps. If it proves noisy in practice, option B is the escape hatch.

### 6.2 The builder check vs. the `spec-review` step

These are different instruments, which is why a naive port breaks:

| | Local `spec-review` today | Upstream builder check |
|---|---|---|
| Who | the agent itself | a fresh subagent |
| Role | mechanical auditor | talented builder **in the domain** |
| Looks for | placeholders, contradictions, ambiguity, scope | questions it would still need answered before it could plan |
| Output | fixes applied inline | ranked questions, sorted into three piles |
| Calibration | — | explicitly skips what the doc delegates to the builder, and skips wording nitpicks |

**Resolution: the mechanical check folds into writing the document; the builder check *is* `spec-review`.**

- The four-point self-review (placeholder scan, internal consistency, scope, ambiguity) runs **while writing**, and its outcome is recorded in `write-spec`'s close reason.
- `spec-review` then means "builder check dispatched, returned, and its questions sorted."
- Rationale: it keeps both instruments without adding a step, and it matches the division of labor upstream already uses in `writing-plans`, where a mechanical Self-Review stays alongside the builder-facing material. It also respects the builder check's own calibration — it deliberately won't catch a placeholder, so something must.

**Three details pinned:**

1. **The prompt lives as a file.** Port upstream's `builder-check-prompt.md` into `skills/brainstorming/` **verbatim** — it contains no visual-companion content, so it needs no excision, and byte-identical keeps the next upstream sync a copy rather than a merge.
2. **Dispatching as `general-purpose` is a real trade-off.** The domain fill-in (`You are a talented [DOMAIN]`) makes a static `agent-templates/` entry a poor fit, so the check dispatches as `general-purpose`. Consequence: unlike the repo's other dispatched roles, it is **not routable through `subagent-models` config**. Recorded, not discovered later. A `builder-check` agent template is a rejected alternative.
3. **Ordering and the verdict.** write → commit → builder check → fold answers, marking the agent's own minor calls as its own → `spec-approved` human gate. `reference/verdict-recording.md` gains one amendment: `spec-review`'s close asserts the check returned and was sorted.

**One upstream sentence dropped:** "When you tell your human partner you're writing it up, say a reviewer will read it first and you may come back once with a few questions." Upstream's PR notes it exists because Claude Code subagents run in the background. Under pi the `Agent` tool can be dispatched blocking, so the sentence is either unnecessary or misleading depending on dispatch mode — which is left to `/plan` (§10). Disposition: `drop — harness-specific`.

---

## 7. Formula changes

`formulas/superpowers-workflow.formula.toml`, version 1 → 2.

**9 steps → 7.** Upstream's narrative has no `explore`, no `approaches`, and no separate `clarify`: recon is offered mid-conversation on the human's say-so, and "think wide privately" is explicitly private.

| Old id | New id | Title | `needs` | Rationale |
|---|---|---|---|---|
| `explore`, `clarify`, `approaches` | **`conversation`** | `Draw out intent: {{topic}}` | — | upstream folds recon, questions, and private option-generation into one continuous phase; three steps there would invent gates upstream deliberately removed |
| `design` | **`playback`** | `Play back understanding` | `conversation` | renamed to upstream's term; the size is recorded in this step's close reason rather than given its own step |
| `design-approved` | unchanged | `User approves the full description` | `playback` | title already matches upstream; `[steps.gate] type = "human"` unchanged |
| `write-spec` | unchanged | `Write the design document` | `design-approved` | project size only; closed-as-skipped otherwise (§6.1) |
| `spec-review` | unchanged id | `Builder check` | `write-spec` | content changes (§6.2) |
| `spec-approved` | unchanged | `User reviews the document` | `spec-review` | gate unchanged |
| `implement` | unchanged | `Implement {{topic}}` | `spec-approved` | unchanged |
| `wrap-up`, `verify`, `smoke-test-approved` (gate), `finish` | unchanged | | | unchanged |

**Two things that make this cheaper than it looks:**

1. **The step ids are not pinned in any test.** The `explore` matches in the test tree are the *subagent type*, not the formula step. This is a formula edit plus skill-text edit, not a test rewrite.
2. **The formula is validated generically** by `test/workflow-formula.test.mjs`, and the bundled formula is auto-seeded to `~/.beads/formulas/` as a symlink by `extensions/formula-seed.ts` — so a formula change needs no packaging change.

**Open for `/plan`:** whether `size` deserves its own step (between `playback` and `design-approved`) or stays folded into `playback`'s close reason. The recommendation here is folded — the user's explicit preference is against step inflation, and the size is fully recoverable from the close reason.

---

## 8. `writing-plans` changes

Local `writing-plans` is adapted far more than `brainstorming`: its plan output is **beads, not a document**, so it has no plan file, and it carries two local additions (`## Creating Tasks as Beads`, `## Self-Review` item 6). Upstream's changes to it are smaller than brainstorming's, but one of them **inverts a local file**.

### 8.1 What ports cleanly

| Upstream change | Disposition | Local destination |
|---|---|---|
| `## Overview` reworded | adopt verbatim | `## Overview` — replaces "zero context / questionable taste / assume they don't know good test design" |
| `## Step Granularity` (was `## Bite-Sized Task Granularity`; "one action with a checkable result") | adopt verbatim | rename local section |
| `plan-document-reviewer-prompt.md` deleted | already absent (no-op) | — |
| `## Self-Review` item 2 → "Step scan" | adopt verbatim | `## Self-Review` item 2, pointing at `reference/red-flags.md` |
| `## Self-Review` item 4 "Review Focus" | adopt verbatim | `## Self-Review` item 4 |
| `## Self-Review` new item 5 "Proportion" | adopt verbatim | `## Self-Review` item 5 |
| local `## Self-Review` item 6 (lifecycle-duplicate check) | **keep** | mark in the doc as a local addition upstream lacks |
| `## Task Structure` Step 3 → signature + one line on approach | adapt | `reference/task-template.md` |

### 8.2 The inversion — `reference/red-flags.md`

The local catalog is the old upstream "No Placeholders" text, and two of its six bullets are now **wrong**:

- Still correct: "TBD", "TODO", "implement later"; "Add appropriate error handling" / "add validation" / "handle edge cases"; "Write tests for the above"; "Similar to Task N"; references to types or functions no task defines.
- **Now backwards:** "Steps that describe what to do without showing how (**code blocks required for code steps**)". Upstream v7.0.0: *"A plan is the set of decisions the implementer cannot make alone. A plan longer than the code it describes has written the code instead."*

So the file is **rewritten, not extended**, around **two opposite failure modes**:

- **A gap** — a line that decides nothing ("handle edge cases", "add appropriate validation", a type no task defines).
- **A transcript** — a body the signature and tests already determine.

Upstream keeps this list inline in the skill; the local `reference/` convention is kept instead, with `## Self-Review` item 2 pointing at it.

**Drafted** (replacing the file's current `# No Placeholders` body):

```markdown
# Step Red Flags

A step is done when the implementer can write exactly one reasonable thing
from it. That is the whole requirement: **unambiguous, not complete.** Two
opposite failures break it, and a plan can have both.

## A gap — a line that decides nothing

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without the test's name and its assertions)
- "Similar to Task N" (the implementer may read tasks out of order — the
  Interfaces block is what carries the shared signature)
- A type, function, or method no task defines

## A transcript — a body the signature and tests already determine

- A function body in a code step whose signature and covering test pin the
  behavior; the implementer writes the body
- Exact copy that no step in the spec fixes

A plan is the set of decisions the implementer cannot make alone. A plan
longer than the code it describes has written the code instead.
```

Note the flipped bullet: the current file says "code blocks required for code steps", which is now the *transcript* failure rather than the *gap* failure. The two headings exist so the inversion is visible to the next reader instead of reading as a lost rule.

### 8.3 Upstream's plan *document* sections — and a corrected finding

v7.0.0 has `## Plan Document Header`, `## Global Constraints`, and `## Review Focus`, all of which hang off a plan *file*. Local has no plan file: "the plan output is the task beads, not a separate document."

**This was flagged as an assumption during design and has now been verified by reading `executing-plans` and `subagent-driven-development`. The verification overturned the design-stage recommendation, which was to put these on the `implement` step's description. They do not go there, and doing so would create a competing second home for something the fork already has.**

The findings:

1. **`## Global Constraints` is already implemented locally.** The fork authors a Global Constraints block into the **plan-approval gate bead's description** — `reference/creating-task-beads.md` calls it "the canonical Global Constraints artifact… this is where the constraints block is authored (exact values, exact formats, stated component relationships). It stays readable after the gate is resolved/closed." It is created by `beads_create_list({ parent, gate: { description: "## Global Constraints\n…" }, tasks: [...] })` and read back with `beads_show({ id: GATE_ID, full: true })`. So the disposition for upstream's `## Global Constraints` is **adapt — the home already exists; only upstream's content rule needs adopting** ("one line each, with exact values copied verbatim from the spec. Every task's requirements implicitly include this section").
2. **`subagent-driven-development` already consumes it as the attention lens.** `scripts/wave-parallel.js`, `scripts/fix-loop.js`, and `scripts/final-review.js` all hand reviewers and implementers "Global Constraints (attention lens), from a codemode script: `beads_show({ id: "<gateBeadId>", full: true })`". SDD's Setup calls the gate bead "the single source handed to reviewers (task beads still inline the constraints for implementers)". **The SDD route needs no change.**
3. **`executing-plans` does not read it at all** — Step 1 checks only that the *human* gate is closed (`beads_show({ id: "<plan-approval-human-gate-id>" })`), then works task beads directly. So on the executing-plans route nothing currently surfaces the plan-level constraints to whoever works a task. **This is the one real gap the verification found**, and it is a one-line addition to `executing-plans` Step 1: read the gate bead's description alongside the task beads.
4. **`## Review Focus` has no local equivalent and belongs in the same place** — the plan-approval gate bead's description, alongside Global Constraints. It is plan-level and reviewers already read that bead. Upstream's nuance is preserved: the *list* is written once at plan level, and **each line's test goes into the owning task**, in that task's own step style.
5. **`## Plan Document Header` has no local home and does not need one** — there is no plan document to head. Its remaining content (Goal, Architecture, Tech Stack, Spec path) is plan-level metadata; the same gate bead's description is the natural place for it, but it is a nice-to-have rather than a requirement. Recommend recording it as `adapt — optional` rather than inventing a home for it.

**Net effect on scope:** §8.3 shrinks from "the one genuinely open adaptation" to one new plan-level section (Review Focus) in an existing artifact, one content-rule adoption (Global Constraints wording), and one one-line fix to `executing-plans`. No change to the `implement` step.

**Drafted:** two changes to `reference/task-template.md`.

Step 3, replacing the current `### Step 3: Write minimal implementation` plus its code block:

````markdown
- [ ] **Step 3: Implement `function(input: InputType) -> ResultType` in `exact/path/to/file.py`**

One line on the approach when the signature and the test leave a choice
(which library call, which data structure); a code block only for an
algorithm they do not determine.
````

The `Interfaces` block, gaining a pointer to the plan-level constraints:

````markdown
**Interfaces:**
- Consumes: [what this task uses from earlier tasks — exact signatures]
- Produces: [what later tasks rely on — exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]
- Constraints: the plan-approval gate bead (`RESULT.gate`), which holds the
  Global Constraints and Review Focus blocks. Read it before you start —
  `beads_show({ id: "<plan-approval-gate-bead-id>", full: true })`.
````

The third line points at the **plan-approval gate bead**, not the `implement` step (§8.3 finding 1). It is cheap insurance: on the SDD route the dispatch scripts already pass the constraints, but on the `executing-plans` route a task worker has no other pointer to them.

---

## 9. Out of scope, and one folded item

Recorded so each is a decision rather than an omission. Items 1–5 are out of this port's scope entirely. Item 6 is **in scope but deliberately not analysed here** — it is three one-line fixes that need no design, so it is tracked as a single bead (§11, B4) rather than a section of this document.

1. **The visual companion.** Dropped per-section (§3.2), so the excision is auditable rather than implicit.
2. **Bonded two-formula sizing** — follow-up if close-as-skipped proves noisy; requires a new `beads_mol_bond` tool in pi-beads.
3. **Extension-driven tracking** — moving the beads layer out of skill prose entirely; a bigger project than this port.
4. **A `builder-check` agent template** — rejected in favour of the verbatim prompt file, with the `subagent-models` routability trade-off noted (§6.2).
5. **Upstream's design doc and eval results** — cited as evidence in §1.1, not ported.
6. **The three upstream one-line fixes** (in scope, folded) — `executing-plans` (`task-done` records `→ (no output)` for a silently-passing command), `requesting-code-review` (`cut -d' ' -f1` instead of `awk '{print $1}'`), `systematic-debugging` (report only *whether* the identity variable is set). Folded into a single bead (§11, B4) rather than split three ways or analysed here.

---

## 10. Left to `/plan`

Deliberately not decided here:

- **Builder-check dispatch mode** (blocking vs. background) — which determines whether upstream's "say a reviewer will read it first" sentence is droppable or necessary (§6.2).
- **The exact wording of every new/changed `SKILL.md` section** — §4, §5, and §8 draft it; the plan makes it authoritative.
- **Whether `size` gets its own formula step** or stays folded into `playback`'s close reason (§7).
- ~~Whether §8.3's downstream wiring is in this port~~ — **settled during spec review**: `subagent-driven-development` already consumes the plan-approval gate bead's Global Constraints as its attention lens and needs no change; `executing-plans` does not read it and needs a one-line addition (§8.3 findings 2–3).
- **Whether the close-as-skipped cost is acceptable in practice**, or whether option B (new `beads_mol_bond` tool) is worth the pi-beads change (§6.1).

---

## 11. Epic and beads

One epic plus **four** beads, grouped so each is one coherent change that leaves the repo consistent:

| Bead | Contents | Files | Depends on |
|---|---|---|---|
| **B1 — brainstorming re-base** | upstream spine + tracking layer, the 9→7 step folds, gate collapse, size-conditional boundaries, `builder-check-prompt.md` port, and the four `reference/` re-derivations | `skills/brainstorming/*`, `formulas/superpowers-workflow.formula.toml` | — |
| **B2 — writing-plans v7** | Overview, Step Granularity, What a Step Contains, task-template Step 3, the `red-flags.md` inversion, Self-Review items 2, 4, and 5 | `skills/writing-plans/*` | — |
| **B3 — plan-level constraints** | adopt upstream's Global Constraints *content rule* into the existing gate-bead authoring text; add Review Focus to the same bead; add the task-template `Interfaces` constraints pointer; add the one-line gate-bead read to `executing-plans` Step 1. **No change to the `implement` step, and no change to `subagent-driven-development`** (§8.3 findings 1–4) | `skills/writing-plans/reference/creating-task-beads.md`, `skills/writing-plans/reference/task-template.md`, `skills/executing-plans/SKILL.md` | B2 (shared files) |
| **B4 — upstream one-line fixes** | the three fixes from §9.6 | three skills, one line each | — |

**When:** created **with this spec, after the builder check and user approval** — so the backlog reflects the approved document rather than a draft, and so the epic stays outside the "no implementation action before approval" gate.

---

## 12. Success criteria

- A reader can take this document plus upstream v7.0.0 and produce the port without re-deriving any decision.
- Every upstream section of every source appears exactly once in §3, and every `drop` carries a reason.
- The two hard cases (§6) are resolved with a stated mechanism and a stated cost, not deferred.
- The epic is four beads, not fifteen.
