# Upstream Sync Tier 2 (2.1) — Design Spec

**Date:** 2026-07-28
**Branch:** feat/skills-upstream-sync (current — no new branch)
**Source:** `obra/superpowers` @ HEAD (v6.2.0, commit `3dcbd5c`)

## Goal

Port the `using-superpowers` skill from the original `obra/superpowers` into this
fork, Option B (trimmed), and update the skill-count references. This is the sole
remaining item in Tier 2 scope — item 2.2 (document-reviewer prompts) was dropped
after design investigation (they are orphaned upstream; the real review mechanism
is Tier 4 content). Items 2.3/2.4 (SDD rework) are deferred to a separate effort.

## Scope — one work item

### Port `using-superpowers` skill (Option B: trimmed)

**Why:** The skill was never ported at conversion. Its valuable, novel content is
the Red Flags rationalization table, Skill Priority rules, and User Instructions
precedence. The fork currently has no bootstrap/meta skill for skill-invocation
discipline.

**Option B (trimmed) — chosen over Option A (full) to keep context clean and
align with the roadmap's command-driven phase-advancement direction:**

The original's aggressive "invoke skills before ANY response (including
clarifying questions, exploring, checking files)" Rule + emphatic
`<EXTREMELY-IMPORTANT>` mandate would push the agent to load skill files on
nearly every message — a context-pollution risk. The roadmap's `/superpowers`
command-driven direction (Future) makes skill invocation intentional and
user-driven (`/brainstorm` loads the skill with purpose), keeping context clean
by loading skills only when doing that work. So we drop the aggressive mandate
and keep the genuinely valuable content.

### Files to create

1. `skills/using-superpowers/SKILL.md` — adapted from upstream, with the
   Option B trims and fork-convention adaptations below.
2. `skills/using-superpowers/references/pi-tools.md` — verbatim from upstream
   (already pi-specific; mentions `pi-subagents`). Creates the
   `references/` subdir.

### Adaptations to `SKILL.md` (deviations from upstream verbatim)

1. **Frontmatter description** — rewrite from upstream's *"requiring skill
   invocation before ANY response including clarifying questions"* to:
   *"Use when starting any conversation — how to find and invoke relevant skills, with rationalizations for skipping them."*
   (Keeps the trigger; drops the aggressive mandate.)
2. **Drop the `<SUBAGENT-STOP>` block** — upstream-specific boilerplate about
   subagent skill leakage; doesn't fit the fork's model; noise. (Keep-context-clean
   principle.)
3. **Drop the `<EXTREMELY-IMPORTANT>` block** — the emphatic "1% chance → you
   ABSOLUTELY MUST / not negotiable / cannot rationalize" mandate. This is the
   aggressive "before ANY response" Rule in emphatic form; dropping it is the
   core of Option B.
4. **Soften "## The Rule" (Option i):** replace with:
   *"Invoke relevant or requested skills before acting on a task. If it turns out wrong for the situation, you don't have to use it. Then announce 'Using [skill] to [purpose]' and follow the skill exactly. If it has a checklist, create a todo per item."*
   (Drops the "before ANY response / clarifying questions / exploring / checking
   files" over-reach; keeps the discipline for actual tasks + the
   announce/checklist convention.)
5. **Keep verbatim:** "## Skill Priority", "## Red Flags" rationalization table,
   "## User Instructions".
6. **"## Platform Adaptation" — trim to pi only:** drop the Codex and
   Antigravity lines; keep only `- Pi: `references/pi-tools.md``. (Gemini
   reference no longer exists upstream.)
7. **Skill-reference syntax:** convert upstream's `superpowers:brainstorming` /
   `superpowers:systematic-debugging` to the fork's `/skill:brainstorming` /
   `/skill:systematic-debugging` convention.

### `references/pi-tools.md` — no changes

Copy verbatim from upstream. It is already pi-specific and accurate (maps
"dispatch a subagent" → `pi-subagents` package; "create a todo" → installed
todo tool or `TODO.md`).

### Doc-count updates

Adding `using-superpowers` makes the skill count 13. Update "12 workflow skills"
→ "13 workflow skills" (or equivalent) in:

- `README.md` line 11
- `README.md` line 311 (comparison table row)
- `README.md` line 353 (directory tree comment)
- `ROADMAP.md` line 167 (Skill consistency pass)

Historical `docs/plans/*` mentions of "12 skills" stay as-is (records of past
work, out of scope).

## Overlap/contradiction check (done during brainstorming)

- **vs `/superpowers` command (ROADMAP, Future):** no overlap or contradiction.
  `/superpowers` is a user-facing TUI command for inspecting/controlling workflow
  state (status, tasks, stage, reset). Command-driven phase advancement makes
  user commands the primary phase-entry mechanism. `using-superpowers` is
  agent-facing skill-invocation discipline. Different layers, orthogonal. Option
  B (dropped aggressive mandate) is *more* aligned with the command-driven
  direction than Option A would have been.
- **vs workflow-monitor extension:** no contradiction. The monitor enforces
  workflow *phases* (TDD/debug/verification/commit gating); `using-superpowers`
  is about *checking whether a skill applies* before acting. Complementary.

## Out of scope

- 2.2 (document-reviewer prompts) — dropped (orphaned upstream; real review
  mechanism is Tier 4 content).
- 2.3/2.4 (SDD rework) — separate effort after this lands.
- Any other Tier 4 SKILL.md merges.
- Visual companion (Tier 3).
- Other-harness reference files (codex-tools.md, antigravity-tools.md,
  gemini-tools.md).

## Verification

- `npm test` (vitest) — all existing tests pass (no code/logic change; this is a
  new skill + reference + doc-count edits). No new unit test is meaningful here
  (skill content is prose).
- `npm run lint` (biome) — clean (markdown not linted by biome; no TS changes).
- Manual: `skills/using-superpowers/SKILL.md` has valid frontmatter
  (`name`/`description`); `references/pi-tools.md` exists and is referenced.
- Manual: grep "12 workflow skills" / "12 skills" in README.md and ROADMAP.md
  returns no stale count references in the four target spots.
- Skill dir well-formed: `skills/using-superpowers/` contains `SKILL.md` +
  `references/pi-tools.md`.

## Setup

Work on the current branch `feat/skills-upstream-sync`. No new branch. This is
content creation (a new skill), not logic — implement directly with review
(checks: frontmatter validity, reference file presence, doc-count correctness,
no regression in test/lint).
