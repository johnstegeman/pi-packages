---
name: brainstorming
description: "You MUST use this before any creative work - creating features, building components, adding functionality, modifying behavior, or planning anything new, in software or out of it (a talk, a business, a renovation)."
disable-model-invocation: true
---

> **Related skills:** Consider `/skill:using-git-worktrees` to set up an isolated workspace. Only
> work that sizes to a project continues in `/skill:writing-plans` (run `/plan`); a quick task and
> a small change both do not. A small change continues in the molecule's `implement` step instead.

# Brainstorming

You are very good at building. You build what you believe your human
partner wants, and that belief is usually thinner than it feels. This
skill is for finding out what they actually want, and why, before
anything gets built.

People often haven't finished working out what they want. Good questions
help them think it through. When you understand the why, you make the
hundred decisions they never mention the way they would have made them.

At the start of the skill, call `set_phase({ phase: "brainstorming" })`.

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

**Brainstorming an existing bead** (e.g. "brainstorm beads-kp0"): an existing issue
does not release you from pouring. Pour a NEW molecule as above, seeding `topic` with
the existing issue's title, then link the new root to the existing issue without
mutating it:

  beads_dep({ issue: "<new-root-id>", blocker: "<existing-issue-id>", type: "discovered-from" })

If `discovered-from` is rejected by your `bd` version, use `related` instead — both
are non-blocking link types; never use `blocks`. The existing issue's type, parent, and
status stay exactly what they were.

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
| `conversation` | you have drawn out intent — questions, playback, and any recon your partner asked for are one continuous phase. Every line of **Ground to cover** is either what they told you or your call — name which in the close reason |
| `playback` | your partner has corrected your playback and you agree on the description. **Record the size in the close reason** (`size: project` / `size: small change`) |
| `design-approved` | your partner approved the full description — in chat for a small change, by reading the document for a project |
| `write-spec` | the document is written and committed, and the four-point self-review is clean. **Project size only** — for a small change, close this and `spec-review` as skipped (`"small change: description agreed in chat"`) and **resolve the gate** (`beads_gate_resolve`), which closes the gated `spec-approved` step in the same call |
| `spec-review` | the builder check returned and its questions were sorted (§ The Written Design) |
| `spec-approved` | your partner has reviewed the document and answered the "theirs" pile |
| `implement` | **project:** leave open — it represents the whole implementation phase, and `writing-plans` creates the task beads under it. **small change:** the work is done directly here; close it when it is done, so `wrap-up`/`verify`/`finish` can run |

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

**Small change:** `spec-approved` is skipped, but its gate still blocks `implement`.
Resolve it without a verdict: close `write-spec` and `spec-review` as skipped, then
`beads_gate_resolve({ id: "<spec-approved-gate-id>" })` — the one call resolves the gate
and closes the gated `spec-approved` step, freeing `implement`. Find it via
`beads_list({ label: "step:gate-spec-approved", mol: "<root-id>" })`.

> **Read now:** [reference/verdict-recording.md](reference/verdict-recording.md) — resume, changes-requested, and gate-resolve edge cases.

## First: What Do You Actually Know?

Before you reply, ask yourself: what do I know about what they want, and
why?

- **Everything that matters is in the request** ("make the icon cornflower
  blue"). This is a quick, clear task. Do it, and say what you did.
- **Something non-trivial is missing.** Start the conversation.

## Your First Message

Your first message is two things, in this order:

1. One line letting them know that if they'd rather skip the questions and
   have you just start, they can say so. If they take you up on it, this
   skill is done: state any significant how-it-gets-made choice
   (platform, language, medium) in one plain line, then do what they
   asked through the normal workflow. This path uses no tracking steps; a
   molecule already poured is simply left where it is.
2. One open question that gets them describing. Ask about a real moment
   or a concrete picture: "What's the moment you find yourself wishing
   this existed?" or "Tell me about the people who'll be in the room."

That's the whole message.

## The Conversation

Each message ends with one question: a single sentence with no list of
example answers hanging off it. Use plain language, pitched just a little
above where your human partner is. Match their vocabulary; never use
process jargon.

Be clear and concise. Lead with what matters. Avoid jargon. When you
report what you found, give them the most important findings and offer
the rest.

**Get them describing.** Open questions come first. Their own words carry
intent that your options can't. Offer a short menu only when they're
stuck. When they say "just guess" or "what do you think?", propose
something concrete.

**How it gets made.** Every project rests on choices about medium, tools,
materials, and resources: the platform, programming language, and
libraries for an app; the medium for a piece of art. Find out early which
of those choices they want to make, which they're handing to you, and what
they already have to work with. Someone with strong views or skills will
want to talk it through. Someone counting on you needs sensible defaults,
said in plain words. When there's existing work, build on what it already
uses. Any choice you make goes in the design as your call, never as
something they agreed to.

**Ground to cover.** This is territory, not a script. Never read these
out as questions:

- what kind of thing this is, and what makes it special
- why now, and what success looks like to them
- goals, non-goals, and anti-goals (what would make this a failure even
  if it technically works)
- prior art: what they've seen elsewhere, loved or hated
- current state: what exists now, what they've tried
- the details they care about

**Enough is not a number.** Ask as many questions as the load-bearing decisions need —
often more than one, and for a request that already states every decision that matters
("make the icon cornflower blue") none at all. The test is coverage, not count: a
decision is load-bearing when a wrong guess changes what gets built. Walk the **Ground
to cover** list before you size the work, and be able to say of each line either what
they told you or that it's your call — and say it out loud when it's your call. *(A
local addition: upstream leaves the question count to the model's judgement.)*

**Questions that work** anchor in specifics: "Walk me through the last
time...", "If it could only do one of these well, which?", "What would
make you wince if I got it wrong?" A guess they can correct ("I'm
guessing this is because X keeps biting you?") often beats a question.

**Offer recon.** Once you have a bit of grounding and looking would help,
offer to go look: their codebase or project, their own files and data,
or the web. Say what you'd look for. They decide whether you go.

**Think wide privately.** Before you propose anything, come up with
several ideas and drop the weak ones, including any that fight what
they've told you about why. Show the comparison only when it helps them
decide.

**Spike to feel things out.** Agentic work is waterfall, but very, very
fast. A quick throwaway build is often the cheapest way to learn what
they want or whether something works. Offer one when it would help.
When they just want to spike, get out of the way. Spikes get no tests
or minimal ones, aren't bulletproof, and skip the plan, implementation,
and review process. Bring what the spike taught you back into the
conversation.

## Play It Back

Play back as you go. As soon as you understand one part well enough to
describe it (what it's for and who it serves, say, or how one piece
behaves), describe that part back in about 200-300 words, then return to
questions about the next part. Playback and questions alternate through
the whole conversation; the last chunk covers whatever is left.

Mark anything you're guessing as your guess; only what they said goes in
as theirs. End each chunk by asking what's wrong or missing.

## Size the Work

Once you understand what they want, pick a size and say it in plain
words. They can override it.

| Size | The full description | Then |
|------|----------------------|------|
| A quick, clear task | the request itself | do it |
| A small change | in chat | worked directly in the `implement` step |
| A project with a written design | a written design document | a full plan (for software: superpowers:writing-plans) |

If it grows mid-task, stop, say so, and step up a size.

If this is really several independent projects, say so, agree on an
order, and brainstorm them one at a time.

**Tracking:** this is the branch that decides the molecule's fate — a small
change closes `write-spec` and `spec-review` as skipped and resolves the
`spec-approved` gate, a project works them all. See [Tracking This Session](#tracking-this-session).

## The Written Design

For a project, write a plain document a talented builder in the domain
could plan from without going back to your human partner. Cover:

- intent and the why
- goals, non-goals, anti-goals
- constraints
- the parts of the how they decided, as they decided them
- what's left to the builder

**Where it goes:** in a software repo,
`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, committed.
Otherwise, ask. Your human partner's preferences override both.

**Builder check:** this is the `spec-review` step. Dispatch a fresh subagent
with `builder-check-prompt.md` in this directory, blocking
(`run_in_background: false`) — the document must not be handed over until the
check is back. Sort what the builder asks into three piles:

- **Answered already** by the conversation or the project: put the answer
  in the document.
- **Minor:** a sensible builder could settle it without changing what gets
  built. Settle it yourself and mark it in the document as your call.
- **Theirs:** only your human partner can answer it, and the answer changes
  what gets built.

Bring the "theirs" pile in one message, most important first. Update the
document with their answers, then hand it over with a short list of the
calls you made so they can check those while reading. That's the only
round of questions the check produces. Without a subagent tool, read the
document as that builder yourself.

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

<HARD-GATE>
Brainstorming spans many conversation turns, not one. Each tracking step
is real work: claim it when you begin, close it when its output actually
exists in the conversation. Never close several in a row within one turn,
and never treat a step as done because the checklist "looks" finished.
The failure this guards against is batching step closes to make the widget
look complete.
</HARD-GATE>

## Red Flags

| Thought | Reality |
|---------|---------|
| "I'll offer options to save them effort" | Options steer. Ask them to describe it first. |
| "They answered my first question, so the intent is clear" | Clear about what they said, not about what they didn't. Walk the ground-to-cover list before sizing. |
| "I'll ask a few more questions to be thorough" | A question they can't answer better than you is noise. Ask when a wrong guess would change what gets built. |
| "I'll fill in sensible defaults" | Good. Say them out loud. A default they never heard is one they couldn't reject. |
| "I should explain the process first" | Ask your question. The process shows itself. |
| "They said 'sounds good' to the idea" | Approval covers what you showed them. A description you haven't written isn't approved. |
| "The spike works, I'll keep building on it" | Keeping it is a new request. Back through the gate. |

## Boundaries

| Size | Read code and docs | Write to `docs/superpowers/specs/` | Edit anything else |
|---|---|---|---|
| A quick, clear task | yes | no | no — do the work itself |
| A small change | yes | no (the description lives in chat) | no — the work is done directly in the `implement` step once approved |
| A project | yes | yes | no |

## Reference material

- [reference/anti-patterns.md](reference/anti-patterns.md) — the three anti-patterns: too simple to need a document, rushing the steps, exploring before you pour.
- [reference/process-flow.md](reference/process-flow.md) — the brainstorming process-flow diagram and the terminal hand-off state.
- [reference/process-guidance.md](reference/process-guidance.md) — YAGNI, working in existing codebases, design for isolation (a local addition), and the spec self-review.
- [reference/verdict-recording.md](reference/verdict-recording.md) — design-verdict edge cases: changes requested, resume, gate-resolve, and close ordering.
