# Upstream Sync Tier 2 (2.1) Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Port the `using-superpowers` skill (Option B, trimmed) from upstream `obra/superpowers` and update skill-count references.

**Architecture:** One new skill directory with an adapted `SKILL.md` + a verbatim `references/pi-tools.md`, plus four doc-count edits (README x3, ROADMAP x1) and one markdown-file-count edit (README). Content-only — no TypeScript, no logic, so no TDD cycle; verification is test/lint non-regression + manual well-formedness checks.

**Tech Stack:** Markdown skill docs, vitest (regression only), biome.

**Source:** `obra/superpowers` @ HEAD = commit `3dcbd5c` (v6.2.0).

**Branch:** `feat/skills-upstream-sync` (current — no new branch).

---

### Task 1: Create `using-superpowers` skill + pi-tools reference

**TDD scenario:** Trivial change — content creation, no logic to test. Verify by regression (test/lint stay green) + manual well-formedness.

**Files:**
- Create: `skills/using-superpowers/SKILL.md`
- Create: `skills/using-superpowers/references/pi-tools.md`

**Step 1: Create `skills/using-superpowers/references/pi-tools.md` with this EXACT content**

(Verbatim from upstream — already pi-specific.)

```markdown
# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On Pi these resolve to the tools below.

| Action skills request | Pi equivalent |
| --- | --- |
| Dispatch a subagent (`Subagent (general-purpose):` template) | Use an installed subagent tool such as `subagent` from `pi-subagents` if available |
| Task tracking ("create a todo", "mark complete") | Use an installed todo/task tool if available, otherwise track tasks in the plan or `TODO.md` |

## Subagents

Pi core does not ship a standard subagent tool. The `pi-subagents` package is a strong optional companion and provides a `subagent` tool with single-agent, chain, parallel, async, forked-context, and resume/status workflows. If no subagent tool is available, do not fabricate `Task` calls; execute sequentially in the current session or explain that the optional subagent capability is not installed.

## Task lists

Pi core does not ship a standard task-list tool. If a todo/task extension is installed, use its documented tool. Otherwise use Superpowers plan files, checklists in Markdown, or a repo-local `TODO.md` for task tracking. Older Superpowers docs may refer to `TodoWrite`; treat that as the task-tracking action above.
```

**Step 2: Create `skills/using-superpowers/SKILL.md` with this EXACT content**

(Adapted from upstream per the design spec — Option B trim. Frontmatter description softened; `<SUBAGENT-STOP>` and `<EXTREMELY-IMPORTANT>` blocks dropped; "The Rule" softened to Option i; Skill Priority + Red Flags + User Instructions kept verbatim; Platform Adaptation trimmed to pi only; `superpowers:` syntax converted to `/skill:`.)

```markdown
---
name: using-superpowers
description: Use when starting any conversation — how to find and invoke relevant skills, with rationalizations for skipping them
---

# Using Superpowers

## The Rule

Invoke relevant or requested skills before acting on a task. If it turns out wrong for the situation, you don't have to use it.

Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, create a todo per item.

## Skill Priority

When multiple skills apply, process skills come first — they set the approach, then implementation skills (frontend-design, etc.) carry it out. Brainstorming and systematic-debugging are Superpowers' most common process skills, but the rule holds for any of them.

- "Let's build X" → `/skill:brainstorming` first, then implementation skills.
- "Fix this bug" → `/skill:systematic-debugging` first, then domain skills.

## Red Flags

These thoughts mean STOP—you're rationalizing:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check git/files quickly" | Files lack conversation context. Check for skills. |
| "Let me gather information first" | Skills tell you HOW to gather information. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills evolve. Read current version. |
| "This doesn't count as a task" | Action = task. Check for skills. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check BEFORE doing anything. |
| "This feels productive" | Undisciplined action wastes time. Skills prevent this. |
| "I know what that means" | Knowing the concept ≠ using the skill. Invoke it. |

## Platform Adaptation

If your harness is Pi, read its reference file for special instructions:

- Pi: `references/pi-tools.md`

## User Instructions

User instructions (CLAUDE.md, AGENTS.md, GEMINI.md, etc, direct requests) take precedence over skills, which in turn override default behavior. Only skip skill workflows or instructions when your human partner has explicitly told you to.
```

**Step 3: Verify well-formedness**

Run these and confirm:
- `cat skills/using-superpowers/SKILL.md | head -3` → frontmatter has `name: using-superpowers` and a `description:` line.
- `ls skills/using-superpowers/references/pi-tools.md` → file exists.
- `grep -c "EXTREMELY-IMPORTANT\|SUBAGENT-STOP\|before ANY response" skills/using-superpowers/SKILL.md` → returns `0` (the dropped content is absent).
- `grep -c "superpowers:" skills/using-superpowers/SKILL.md` → returns `0` (converted to `/skill:`).
- `grep -c "/skill:brainstorming\|/skill:systematic-debugging" skills/using-superpowers/SKILL.md` → returns `2`.
- `grep -c "references/pi-tools.md" skills/using-superpowers/SKILL.md` → returns `1` (Platform Adaptation wiring intact).

**Step 4: Run regression checks**

Run: `npm test`
Expected: all tests pass (no code change; 40 files / 380 tests as of Tier 1).

Run: `npm run lint`
Expected: clean.

**Step 5: Commit**

```bash
git add skills/using-superpowers/SKILL.md skills/using-superpowers/references/pi-tools.md
git commit -m "feat(skills): port using-superpowers skill (Option B, trimmed)

Add the bootstrap/meta skill for skill-invocation discipline: The Rule
(softened), Skill Priority, Red Flags rationalization table, Platform
Adaptation (pi only), User Instructions precedence. Drops upstream's
aggressive 'invoke before ANY response' mandate + EXTREMELY-IMPORTANT +
SUBAGENT-STOP blocks to keep context clean and align with the roadmap's
command-driven direction. references/pi-tools.md verbatim from upstream."
```

---

### Task 2: Update skill-count references in README and ROADMAP

**TDD scenario:** Trivial change — doc edits, no logic.

**Files:**
- Modify: `README.md` (lines 11, 311, 353)
- Modify: `ROADMAP.md` (line 167)

**Why:** Adding `using-superpowers` makes the skill count 13 (was 12) and the skill markdown-file count 26 (was 24). Live count references must stay accurate.

**Step 1: Edit README.md line 11**

Change:
```
**12 workflow skills** that guide the agent through a structured development process - from brainstorming ideas through shipping code.
```
to:
```
**13 workflow skills** that guide the agent through a structured development process - from brainstorming ideas through shipping code.
```

**Step 2: Edit README.md line 311**

Change:
```
| **Skills** | 12 workflow skills | Same 12 skills (pi port) | Same 12 skills (three-scenario TDD, restored inline guidance) |
```
to:
```
| **Skills** | 13 workflow skills | Same 13 skills (pi port) | Same 13 skills (three-scenario TDD, restored inline guidance) |
```

**Step 3: Edit README.md line 353**

Change:
```
├── skills/                           # 12 workflow skills (24 markdown files)
```
to:
```
├── skills/                           # 13 workflow skills (26 markdown files)
```

**Step 4: Edit ROADMAP.md line 167**

Change:
```
- **[maintainer]** Skill consistency pass — normalize wording, boundaries, and stop conditions across all 12 skills
```
to:
```
- **[maintainer]** Skill consistency pass — normalize wording, boundaries, and stop conditions across all 13 skills
```

**Step 5: Verify no stale counts remain**

Run: `grep -rn "12 workflow skills\|all 12 skills\|Same 12 skills\|24 markdown files" README.md ROADMAP.md`
Expected: no matches (all four target spots updated). Note: historical `docs/plans/*` mentions of "12 skills" are out of scope and should NOT be edited — restrict this grep to README.md and ROADMAP.md.

Run: `grep -rn "13 workflow skills\|all 13 skills\|Same 13 skills\|26 markdown files" README.md ROADMAP.md`
Expected: matches in the four updated spots.

**Step 6: Run regression checks**

Run: `npm test` and `npm run lint`
Expected: both pass (doc-only edits).

**Step 7: Commit**

```bash
git add README.md ROADMAP.md
git commit -m "docs: bump skill count 12 → 13 after porting using-superpowers

Update live count references in README (3 spots: intro, comparison
table, dir tree) and ROADMAP (skill consistency pass). Historical
docs/plans mentions left as-is."
```

---

## Verification (after both tasks)

- `npm test` — all green.
- `npm run lint` — clean.
- `git log --oneline -2` — two commits, one per task.
- `skills/using-superpowers/` contains `SKILL.md` + `references/pi-tools.md`.
- No stale "12 workflow skills" / "24 markdown files" in README.md or ROADMAP.md.
