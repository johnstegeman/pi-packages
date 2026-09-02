# set_phase Observability Tool & Skill Amendments — Design

**Goal:** Add a `set_phase` tool that emits a single state event on the pi
EventBus channel `superpowers:phase`, and amend the six phase-boundary skills
to call it at skill start with the correct phase value. The events are for
observability tooling (e.g. cost tracking by phase); no observability consumer
ships with this change.

## Phase Model

Two canonical phases:

| Phase value | Applies to |
|---|---|
| `brainstorming` | `brainstorming` and `writing-plans` ("plan") skills |
| `development` | `executing-plans`, `subagent-driven-development` (the two development options), and `requesting-code-review` / `receiving-code-review` (code review + fixes are still development) |

The tool accepts **any string** for the `phase` parameter so it can be
extended in the future without breaking consumers. The skills always pass one
of the two canonical values above.

## Design Decisions

1. **Single state event.** Each `set_phase` call emits `{ phase }` on
   `superpowers:phase`. There is no paired enter/exit event; consumers infer
   that a new phase arrival ends the previous one. (Decision Q2-A.)
2. **Payload is just `phase`.** No timestamp, session id, or other fields.
   (Decision Q3.)
3. **Tool returns empty content.** The call is invisible to the model; the
   skill's own narration drives the workflow. (Decision Q4.)
4. **Bundled in this package.** A new `extensions/set-phase.ts` registers the
   tool, and the `package.json` `pi` manifest gains an `extensions` entry.
   This reverses the "no bundled tools" posture from the v0.6.0 companion
   migration for this one tool. (Decision Q5-A.)
5. **Six boundary skills only.** Supporting skills (TDD, debugging,
   verification, worktrees, finishing, parallel agents) are already inside
   `development` and emit nothing. (Decision Q6-A.)
6. **Call at skill start**, alongside the skill's announce, with the exact
   value. (Decision Q8-A.)
7. **Tool description steers non-superpowers skills away** from calling it.
   The skills themselves carry the exact values to pass. (Decision Q7.)
8. **No runtime inference and no session-persistence/replay** of phase state —
   the skills drive the calls; the event bus is the sole contract. (Approach 1;
   rejects the appendEntry/persistence idea from Approach 3 as YAGNI.)
9. **No deduplication.** Every `set_phase` call emits unconditionally, even
   when the previous call was already in the same phase (e.g. code review
   right after executing both emit `development`).

## File Changes

### 1. `extensions/set-phase.ts` (new)

Registers the `set_phase` tool:

- `name: "set_phase"`, `label: "Set Phase"`.
- `parameters`: `Type.Object({ phase: Type.String() })` — any string accepted.
- `execute`: `pi.events.emit("superpowers:phase", { phase: params.phase })`,
  then returns empty content: `{ content: [{ type: "text", text: "" }],
  details: {} }`.
- `description`: descriptive, and explicitly steers away non-superpowers
  usage. Exact wording (in the spec):
  `"Emit the current Superpowers workflow phase on the superpowers:phase event bus channel for observability (e.g. cost tracking by phase). Pass \`brainstorming\` during brainstorming or planning, \`development\` during implementation or code review. Only the Superpowers skills should call this — do not use it for ordinary work."`

Imports: `type { ExtensionAPI }` from `@earendil-works/pi-coding-agent` and
`Type` from `typebox` — both are core packages pi bundles for extensions
(declared as `peerDependencies`, per `packages.md`).

### 2. `package.json` — manifest

Add `"extensions": ["./extensions"]` to the existing `"pi"` block (which
currently lists only `"skills": ["skills"]`).

### 3. Six skill files — one instruction each at skill start

Each boundary skill gains a short, explicit instruction telling the model to
call `set_phase` with the exact value, placed with the skill's start/announce
block. Exact wording in the table below; each is a "call `set_phase` with this
exact value at the top of the skill" instruction:

| Skill | Value | Placement anchor |
|---|---|---|
| `skills/brainstorming/SKILL.md` | `brainstorming` | Process intro ("Start by understanding...") |
| `skills/writing-plans/SKILL.md` | `brainstorming` | "Announce at start" | 
| `skills/executing-plans/SKILL.md` | `development` | "Announce at start" |
| `skills/subagent-driven-development/SKILL.md` | `development` | Setup section |
| `skills/requesting-code-review/SKILL.md` | `development` | Intro |
| `skills/receiving-code-review/SKILL.md` | `development` | Intro |

Each call uses the canonical value only; the tool's free-form string is a
future-proofing affordance, not something the skills exercise.

## Testing

- No unit tests for the extension are required in this package's current test
  setup (`biome check .` is the only script; there is no test harness for
  extensions). Verification will be:
  - `biome check .` passes after edits.
  - A manual smoke test loading the extension in pi and invoking `set_phase`
    to confirm the event fires (a temporary listener prints the payload) —
    optional, depends on environment.
  - Grep confirms all six skills contain their `set_phase` call and the
    manifest lists `./extensions`.

## Out of Scope

- Any observability consumer of `superpowers:phase` (e.g. a Langfuse phase
  integration) — downstream, separate change.
- Timestamps/session-id enrichment of the payload.
- Calling `set_phase` from supporting skills, or a separate enter/exit pair.
- Session-persistent phase replay via `appendEntry`.
