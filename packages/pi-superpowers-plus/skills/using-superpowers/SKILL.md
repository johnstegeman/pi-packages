---
name: using-superpowers
description: Use when starting any conversation — how to find and invoke relevant skills, with rationalizations for skipping them
---

# Using Superpowers

## The Rule

Invoke relevant or requested skills before acting on a task. If it turns out wrong for the situation, you don't have to use it.

Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, create a todo per item.

## Session Start: beads cleanup

Before beginning work, clean up beads left behind by interrupted sessions
(a stopped/restarted session cannot close its own wisps). This step applies
only in a beads-initialized project: if the working directory has no
`.beads/` database (check `bd where`), skip it.

1. Run `bd mol wisp gc --dry-run --age 24h` to list abandoned wisps (not
   updated for 24h and not closed) — leftovers from a stopped/restarted
   session.
2. Review the list. If a listed wisp belongs to work you're about to resume,
   keep it by refreshing its timestamp — `bd update <id> --notes "resuming
   <phase>"` — so the sweep below skips it, or use a longer `--age`.
   (`bd mol squash <id>` does NOT promote a directly-created phase wisp; it
   only condenses molecule hierarchies and leaves the wisp open.)
3. Delete the rest: `bd mol wisp gc --age 24h --force` (a wisp untouched for
   a full day and not closed is abandoned; the default 1h threshold is too
   aggressive for resumed phases).
4. This touches **wisps only** — persistent issues are never affected.
5. Confirm the superpowers workflow formula is available in this project:
   `bd formula list | grep superpowers-workflow`. If missing, copy it in from this
   package's bundled copy (`formulas/superpowers-workflow.formula.toml` inside
   the installed `pi-superpowers-plus` package directory) into the project's
   `.beads/formulas/superpowers-workflow.formula.toml`, then re-run
   `bd formula list` to confirm it's now visible. Never overwrite an existing formula
   file of the same name — a user-customized formula takes precedence.

## Working Directory

Always work in the user's current working directory — the project the user opened or `cd`'d into. Never `cd` into or run commands against the directory where a skill file lives (the installed package directory). When a skill says "explore project context" or "check recent commits," it means the user's project, not the skill's install location. The skill's path appears in the prompt only so you can resolve relative file references inside the skill — it is not a working directory.

## Skill Priority

When multiple skills apply, process skills come first — they set the approach, then implementation skills (frontend-design, etc.) carry it out. Brainstorming and systematic-debugging are Superpowers' most common process skills, but the rule holds for any of them.

- "Let's build X" → `/brainstorm` first (loads the brainstorming skill), then implementation skills.
- "Fix this bug" → `/skill:systematic-debugging` first, then domain skills.

## Red Flags

These thoughts mean STOP—you're rationalizing:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Check for relevant skills before acting on the task. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check git/files quickly" | Files lack conversation context. Check for skills. |
| "Let me gather information first" | Skills tell you HOW to gather information. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills evolve. Read current version. |
| "This doesn't count as a task" | Action = task. Check for skills. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check for skills before starting the task. |
| "This feels productive" | Undisciplined action wastes time. Skills prevent this. |
| "I know what that means" | Knowing the concept ≠ using the skill. Invoke it. |
| "The skill prompt shows a path — I should cd there" | That's the skill's install location, not the user's project. Stay in the user's working directory. |

## Platform Adaptation

If your harness is Pi, read its reference file for special instructions:

- Pi: `references/pi-tools.md`

## User Instructions

User instructions (CLAUDE.md, AGENTS.md, GEMINI.md, etc, direct requests) take precedence over skills, which in turn override default behavior. Only skip skill workflows or instructions when your human partner has explicitly told you to.
