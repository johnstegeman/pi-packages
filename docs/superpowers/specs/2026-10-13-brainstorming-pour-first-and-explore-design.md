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
- **It is therefore always worked — never skipped, on any size.** The reading happens before the
  human can opt out; the opt-out governs the steps *after* it (D4).
- **Scope is narrow:** read what the request *points at* — the bead, the spec, the named files —
  plus enough project context to make the first message intelligent. Not repo archaeology. This is
  the reading that makes a pointer evaluable, and the step that forces the molecule to exist before
  any file is read.
- The title keeps the v1 wording `Explore project context` and carries **no** `{{topic}}`: the topic
  stays on `conversation`, where the widget's `topicFor` reads it.
- `needs`: none. `conversation` gains `needs = ["explore"]`.
- Close reason: what you read, and what it told you. When there is nothing to read (a self-contained
  request), say so — *"nothing to read; the request is self-contained"*.

### D3 — The pre-check survives, re-pointed

Keep upstream's section; change its consequence:

- Its two branches now decide whether the first message may lead with the fast-route offer — not
  whether to pour.
- New rule: **a request that points at a document — a bead, a spec, an issue, a file — is never
  self-contained.** Reading it is what `explore` is for; until then you do not know what matters.

### D4 — Three sizes, one molecule

Every session pours; the size decides which steps are *worked*, *approved*, and *closed as skipped*.

| size | worked | approved at a gate | closed as skipped |
|---|---|---|---|
| fast task (human opted out at the first message) | `explore`, `implement` | `design-approved` (the opt-out **is** the approval, D7), `spec-approved` (resolved by the same call that closes it, D6) | `conversation`, `playback`, `write-spec`, `spec-review` |
| small change | `explore` → … → `implement` | `design-approved` | `write-spec`, `spec-review` (and the `spec-approved` gate is resolved to free `implement`) |
| project | all | `design-approved`, `spec-approved` | — |

`explore` appears in the *worked* column for every size (D2). `design-approved` is never *skipped*:
it is either approved in chat or approved by the opt-out — in both cases the step carries
`review.verdict=done` and its gate is resolved.

### D5 — The fast route requires explicit human approval

- The first message keeps upstream's opt-out line (*"if you'd rather skip the questions and have me
  just start, say so"*).
- Only the **human** may take it. The agent may not self-serve it, and must not treat a documented
  intent as an opt-out.
- On approval the agent runs the skip sequence (D6) and works the request directly in `implement`.

### D6 — Skip sequence (close ordering is enforced)

`reference/verdict-recording.md` already documents that `beads_close` fails while a prerequisite or
an open gate blocks the step. The fast route therefore proceeds in order:

1. Close `conversation`, then `playback` as skipped — each becomes ready in turn. (`explore` is
   already closed, worked, from before the first message.)
2. Record `review.verdict=done` on `design-approved` — *"just do it"* **is** the human approving the
   request as the description — then `beads_gate_resolve` on `step:gate-design-approved`, which
   resolves the gate and closes the gated step in one call.
3. Close `write-spec` and `spec-review` as skipped.
4. `beads_gate_resolve` on `step:gate-spec-approved` — resolves the gate and closes `spec-approved`,
   freeing `implement`.

Reason strings: `"fast route: human opted out at the first message"` for the skipped closes;
`"fast route: the opt-out is the approval"` for the verdict.

### D7 — `design-approved` is the chat approval, not the document review

The tracking table says `design-approved` closes *"by reading the document for a project"*. That is
unreachable: `write-spec` has `needs = ["design-approved"]` and close order is enforced, so a
project cannot be approved by document at that step. Corrected semantics:

- `design-approved` = the human approves the full **description**, in chat — for a project, the
  design as played back, before it is written up.
- `spec-approved` = the human reviews the written **document**.

The table row is reworded accordingly.

### D8 — The batch-close HARD-GATE gets a fast-route carve-out

The second `<HARD-GATE>` forbids closing several steps in one turn, because batching closes is how
the widget gets made to look complete without the work existing. The fast route closes four steps
and resolves two gates in a single turn, so the gate needs an explicit exception, or the shipped
skill forbids its own fast route.

The carve-out is narrow and names its condition: **on a fast route the human has just approved, the
skipped steps may be closed in one turn** — they were *considered and declined*, which is what the
close reason records. The gate's substance is unchanged everywhere else.

### D9 — `conversation` on a documented intent is a confirmation pass

The Goal says a documented intent is not re-litigated; D5 says a documented intent is not itself an
opt-out. So after `explore` has read a bead or spec that settles everything, the agent still sends
the first message, and absent an opt-out still works `conversation`. What that step does changes:

- It is a **confirmation pass**, not an interrogation: play back what the document already settles,
  name what it does not, and ask only about genuine gaps.
- Its close condition extends `8c33e25`'s coverage rule by one source: every line of **Ground to
  cover** is either what they told you, **what the referenced document says**, or your call — and
  the close reason names which. A document that answers a line satisfies it exactly as the human's
  own words would.
- When the document leaves nothing open, the close reason says so and no question is asked.

### D10 — The boundary between `explore`'s automatic read and "Offer recon"

`explore` reads the request's **referents** without asking: the bead, spec, issue, or file the
request names, plus the immediately adjacent context needed to understand them. Broader
investigation — the codebase at large, other files, the web — keeps the existing rule: offer it, and
the human decides whether you go. `## The Conversation` → **Offer recon** gains that carve-out so
the two do not contradict each other.

## Widget and test consequences

- `BRAINSTORM_VIEW` gains `explore` at its head. The coupling test derives the view from the shipped
  formula (`BRAINSTORM_VIEW == KEYS.slice(0, KEYS.indexOf("implement"))`), so the omission fails
  loudly rather than silently emptying the view.
- **v1 contract is unchanged: the folded phase stays one row.** A v1 molecule (one carrying
  `step:clarify`/`step:approaches`) renders its explore/clarify/approaches phase as a *single* row
  that follows the live step; the new `explore` key must not add a second row for it. Concretely,
  `resolveRows` must not render a step twice — a legacy candidate already emitted as a real key is
  skipped, and for a v1 molecule the folded group resolves as one row. The existing
  `v1Mid` assertion (*"the folded v1 rows collapse to the live step"*) stays true and is kept.
- `topicFor` is unchanged (the topic still resolves from `conversation`); the
  `Explore project context: ` fallback stays for in-flight v1 molecules.
- `test/beads-molecule-widget.test.mjs`'s fresh-v1 fixture gains an assertion that the explore row
  appears exactly once.
- `test/workflow-formula.test.mjs` gains: `explore` exists, precedes `conversation`, and
  `conversation` needs it.

## Files

| File | Change |
|---|---|
| `formulas/superpowers-workflow.formula.toml` | v3 — add `explore`; `conversation` needs it |
| `skills/brainstorming/SKILL.md` | unconditional pour gate; re-pointed pre-check + pointer rule; `explore` row; fast-route row; `design-approved` row wording; batch-close carve-out (D8); confirmation-pass close condition (D9); "Offer recon" carve-out (D10) |
| `skills/brainstorming/reference/process-flow.md` | dot graph — pour unconditional, `explore` step, fast-route terminal |
| `skills/brainstorming/reference/anti-patterns.md` | "Too Simple" gains the fast route; "Exploring Before You Pour" keeps its rule |
| `skills/brainstorming/reference/verdict-recording.md` | fast-route skip sequence and gate order |
| `extensions/beads-molecule-widget.mjs` | `BRAINSTORM_VIEW` + v1 single-row resolution |
| `test/beads-molecule-widget.test.mjs`, `test/widget-formula-coupling.test.mjs`, `test/workflow-formula.test.mjs` | as above |
| `CHANGELOG.md` | `[Unreleased]` entry |
| `docs/superpowers/specs/2026-10-13-upstream-brainstorming-v7-port-design.md` | mark §6.1/§7 superseded |
| `docs/superpowers/specs/2026-10-13-brainstorming-pour-first-and-explore-design.md` | this document |

## Acceptance criteria

- [ ] A fresh pour produces an `explore` step as step 1, with `conversation` depending on it.
- [ ] `SKILL.md` no longer conditions the pour on the pre-check; the pour gate is unconditional and
      precedes any exploration.
- [ ] The pre-check carries the pointer rule.
- [ ] The fast route is documented as human-approved only, with the exact skip and gate sequence,
      and `explore` is never among its skipped steps.
- [ ] The batch-close HARD-GATE names its fast-route exception.
- [ ] `conversation`'s close condition admits the referenced document as a source of coverage.
- [ ] The `design-approved` table row matches the formula's ordering.
- [ ] `npm test` in `packages/pi-superpowers-plus` passes, including the new coupling assertion, the
      fresh-v1 "exactly once" assertion, and the unchanged `v1Mid` collapse assertion.
- [ ] A v1 molecule renders exactly one row for its folded explore/clarify/approaches phase.

## Risks

- **Bookkeeping weight on the fast route.** Four closed-as-skipped steps plus two gate resolves for a
  cornflower-blue task. Accepted by the human (D4). The escape hatch if it proves noisy is a bonded
  two-formula design, which needs new `beads_mol_*` work in pi-beads.
- **Upstream drift.** D1–D3 deliberately diverge from v7.0.0's §6.1/§7. The next upstream sync must
  re-read those two sections rather than diff-copy them; recorded in the v7 port spec.
- **`explore` before the first message** reintroduces the "repo archaeology first" risk the upstream
  rewrite removed. D2's narrow scope and D10's boundary are the mitigation, and they are unverified
  in the field.

## Out of scope

- The stale v1 template proto in the pi-packages beads DB (`superpowers-workflow`, label `template`,
  created 2026-09-02, 16 steps). Pours read the formula file, not the proto — `bd mol pour
  superpowers-workflow --dry-run` produces the v3 shape — so it is inert for pours and leaks only
  into `bd ready` / `bd mol show`. Filed separately.
- The `smoke-test-approved` gate and the finish phase.
