# Unconditional pour and a restored `explore` step — design

**Date:** 2026-10-13
**Molecule:** `pi-packages-mol-9o057` (`superpowers-workflow`, topic "Restore pour-first and the explore step in brainstorming")
**Supersedes:** §6.1 and §7 of `docs/superpowers/specs/2026-10-13-upstream-brainstorming-v7-port-design.md`
**Scope:** `packages/pi-superpowers-plus` — `skills/brainstorming/`, `formulas/superpowers-workflow.formula.toml`, `extensions/beads-molecule-widget.mjs`, tests, `CHANGELOG.md`.

## Problem

**The evidence.** Session
`~/.pi/agent/sessions/--Users-jstegeman-orca-workspaces-pmm-iris-pmm-iris-091f--/2026-10-13T15-45-19-610Z_01a135f0-8cfa-71ba-9aa3-1b4db2c785a6.jsonl`.

The human opened with a **pointer**: *"for bead pmm-iris-091f - the intent behind it is fully
documented in the bead"*. The agent's private pre-check (`## First: What Do You Actually Know?`)
classified that as *"Everything that matters is in the request"* → quick, clear task → do it. It
never poured a molecule, never sent the first message, never offered the opt-out, never asked a
question. It claimed the **bead** — which reads like tracking but is not the molecule — read the
harness and the four named suites, and made five file edits before the human stopped it
(*"whoa whoa why are you editing files - you are supposed to be brainstorming"*). It then reverted
the edits, poured a molecule, and started over.

**The two v7-port changes that put that branch within reach** (commit `307a9e0`):

1. **The pour became conditional on the agent's own private judgement.** Before the port it was a
   HARD-GATE — pour before reading any file, no judgement call. §6.1 made it conditional on the
   pre-check so that *"make the app icon cornflower blue"* could skip tracking entirely. An escape
   hatch an agent can serve itself is one it will eventually serve itself.
2. **`explore` was deleted.** §7 folded `explore`/`clarify`/`approaches` into one `conversation`
   step. Recon lost its tracked home, and with no step 1 nothing forces a molecule to exist before
   files are read.

**The structural defect is in the pre-check itself.** It is *deliberately exploration-free*, so it
cannot evaluate a request whose content lives in a document — "go read the bead" is precisely what
it must not do. A pointer is therefore never self-contained, and the shipped text gives the agent
neither a way to tell a pointer from a self-contained request nor any reason to prefer the
conservative branch when unsure.

## Goal

- Every brainstorming session pours the molecule before anything is read.
- A request that points at a document is **read** before the agent's first message.
- An already-documented intent is not re-litigated.
- The fast path still exists, but only on explicit human approval.

## Non-goals

- Restoring `clarify`/`approaches` as formula steps — they stay folded into `conversation` (upstream
  measured the approaches round as strawman options that steered the human).
- New beads tools (`beads_mol_bond`) or a second, bonded formula.
- Reworking `writing-plans`, `executing-plans`, or the SDD flow.
- Reverting `8c33e25` ("gate brainstorming on decision coverage, not question count") — that change
  is what makes *"don't re-litigate a documented intent"* legal.

## Anti-goals

- A pour that is still conditional on a private judgement, however it is worded.
- Reintroducing repo archaeology before the first message: `explore` reads the request's referents,
  not the codebase at large.
- Step inflation.

## Decisions

### D1 — The pour is unconditional

Restore the pre-port HARD-GATE at the top of the tracking section:

- Pour (`beads_mol_pour`) **and** show the widget (`beads_mol_current`, `beads_mol_ready`) *before*
  reading any file, running any command, or exploring the project in any way.
- An existing bead or epic does not release you from pouring: pour a new molecule seeded with the
  bead's title, link it `discovered-from` (or `related` if the bd version rejects that), and never
  mutate the existing issue.

The `## First: What Do You Actually Know?` pre-check **no longer gates the pour**. The
`<HARD-GATE>` sentence *"If they opted out of the questions, the skill is done and the gate goes
with it"* is reworded: the opt-out now skips *steps*, not the molecule (D4/D5).

### D2 — `explore` returns as formula step 1 (formula v3)

```
explore "Explore project context" → conversation → playback → design-approved (gate)
        → write-spec → spec-review → spec-approved (gate)
        → implement → wrap-up → verify → smoke-test-approved (gate) → finish
```

- `explore` runs **before the first message** (human decision, this session).
- **Scope is narrow:** read what the request *points at* — the bead, the spec, the named files —
  plus enough project context to make the first message intelligent. Not repo archaeology. This is
  the reading that makes a pointer evaluable, and the step that forces the molecule to exist before
  any file is read.
- The title keeps the v1 wording `Explore project context` and carries **no** `{{topic}}`: the topic
  stays on `conversation`, where the widget's `topicFor` reads it.
- `needs`: none. `conversation` gains `needs = ["explore"]`.
- Close reason: what you read, and what it told you.

### D3 — The pre-check survives, re-pointed

Keep upstream's section; change its consequence:

- Its two branches now decide whether the first message may lead with the fast-route offer — not
  whether to pour.
- New rule: **a request that points at a document — a bead, a spec, an issue, a file — is never
  self-contained.** Reading it is what `explore` is for; until then you do not know what matters.

### D4 — Three sizes, one molecule

Every session pours; the size decides which steps are *worked* and which are *closed as skipped*.

| size | worked | closed as skipped | gates resolved |
|---|---|---|---|
| fast task (human opted out at the first message) | `implement` | `explore`, `conversation`, `playback`, `design-approved`, `write-spec`, `spec-review` | **both** (`design-approved`, `spec-approved`) |
| small change | `explore` → … → `implement` | `write-spec`, `spec-review` | `spec-approved` |
| project | all | — | — |

### D5 — The fast route requires explicit human approval

- The first message keeps upstream's opt-out line (*"if you'd rather skip the questions and have me
  just start, say so"*).
- Only the **human** may take it. The agent may not self-serve it, and must not treat a documented
  intent as an opt-out.
- On approval the agent runs the skip sequence (D6) and works the request directly in `implement`.

### D6 — Skip sequence (close ordering is enforced)

`reference/verdict-recording.md` already documents that `beads_close` fails while a prerequisite or
an open gate blocks the step. The fast route therefore proceeds in order:

1. Close `explore`, then `conversation`, then `playback` as skipped — each becomes ready in turn.
2. Record `review.verdict=done` on `design-approved` — *"just do it"* **is** the human approving the
   request as the description — then `beads_gate_resolve` on `step:gate-design-approved`, which
   resolves the gate and closes the gated step in one call.
3. Close `write-spec` and `spec-review` as skipped.
4. `beads_gate_resolve` on `step:gate-spec-approved` — resolves the gate and closes `spec-approved`,
   freeing `implement`.

Reason strings: `"fast route: human opted out at the first message"`.

### D7 — `design-approved` is the chat approval, not the document review

The tracking table says `design-approved` closes *"by reading the document for a project"*. That is
unreachable: `write-spec` has `needs = ["design-approved"]` and close order is enforced, so a
project cannot be approved by document at that step. Corrected semantics:

- `design-approved` = the human approves the full **description**, in chat — for a project, the
  design as played back, before it is written up.
- `spec-approved` = the human reviews the written **document**.

The table row is reworded accordingly.

## Widget and test consequences

- `BRAINSTORM_VIEW` gains `explore` at its head. The coupling test derives the view from the shipped
  formula (`BRAINSTORM_VIEW == KEYS.slice(0, KEYS.indexOf("implement"))`), so the omission fails
  loudly rather than silently emptying the view.
- **v1 de-dup bug.** With `explore` in the view, a v1 molecule resolves `explore` directly *and*
  `conversation` through `LEGACY_VIEW_FALLBACK` (whose first candidate is `explore`), rendering the
  same step twice. `resolveRows` must drop a legacy step already resolved as a real key.
- `topicFor` is unchanged (the topic still resolves from `conversation`); the
  `Explore project context: ` fallback stays for in-flight v1 molecules.
- `test/beads-molecule-widget.test.mjs`'s v1 fixture gains an assertion that the explore row appears
  exactly once.
- `test/workflow-formula.test.mjs` gains: `explore` exists, precedes `conversation`, and
  `conversation` needs it.

## Files

| File | Change |
|---|---|
| `formulas/superpowers-workflow.formula.toml` | v3 — add `explore`; `conversation` needs it |
| `skills/brainstorming/SKILL.md` | unconditional pour gate; re-pointed pre-check + pointer rule; `explore` row; fast-route row; `design-approved` row wording |
| `skills/brainstorming/reference/process-flow.md` | dot graph — pour unconditional, `explore` step, fast-route terminal |
| `skills/brainstorming/reference/anti-patterns.md` | "Too Simple" gains the fast route; "Exploring Before You Pour" keeps its rule |
| `skills/brainstorming/reference/verdict-recording.md` | fast-route skip sequence and gate order |
| `extensions/beads-molecule-widget.mjs` | `BRAINSTORM_VIEW` + v1 de-dup |
| `test/beads-molecule-widget.test.mjs`, `test/widget-formula-coupling.test.mjs`, `test/workflow-formula.test.mjs` | as above |
| `CHANGELOG.md` | `[Unreleased]` entry |
| `docs/superpowers/specs/2026-10-13-upstream-brainstorming-v7-port-design.md` | mark §6.1/§7 superseded |
| `docs/superpowers/specs/2026-10-13-brainstorming-pour-first-and-explore-design.md` | this document |

## Acceptance criteria

- [ ] A fresh pour produces an `explore` step as step 1, with `conversation` depending on it.
- [ ] `SKILL.md` no longer conditions the pour on the pre-check; the pour gate is unconditional and
      precedes any exploration.
- [ ] The pre-check carries the pointer rule.
- [ ] The fast route is documented as human-approved only, with the exact skip and gate sequence.
- [ ] The `design-approved` table row matches the formula's ordering.
- [ ] `npm test` in `packages/pi-superpowers-plus` passes, including the new coupling and v1 de-dup
      assertions.
- [ ] A v1 molecule renders exactly one `explore` row.

## Risks

- **Bookkeeping weight on the fast route.** Six closed-as-skipped steps plus two gate resolves for a
  cornflower-blue task. Accepted by the human (D4). The escape hatch if it proves noisy is a bonded
  two-formula design, which needs new `beads_mol_*` work in pi-beads.
- **Upstream drift.** D1–D3 deliberately diverge from v7.0.0's §6.1/§7. The next upstream sync must
  re-read those two sections rather than diff-copy them; recorded in the v7 port spec.
- **`explore` before the first message** reintroduces the "repo archaeology first" risk the upstream
  rewrite removed. D2's narrow scope is the mitigation, and it is unverified in the field.

## Out of scope

- The stale v1 template proto in the pi-packages beads DB (`superpowers-workflow`, label `template`,
  created 2026-09-02, 16 steps). Pours read the formula file, not the proto — `bd mol pour
  superpowers-workflow --dry-run` produces the v2 shape — so it is inert for pours and leaks only
  into `bd ready` / `bd mol show`. Filed separately.
- The `smoke-test-approved` gate and the finish phase.
