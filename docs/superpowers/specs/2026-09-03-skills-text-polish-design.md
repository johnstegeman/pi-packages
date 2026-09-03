# Skills-text polish: R5-totality sweep + stale cross-ref + grammar (final-review follow-ups)

Date: 2026-09-03
Status: Approved

Source: follow-up recommendations from the final whole-branch review of the
skills-text updates (`feat/skills-text`, `3c7bd44..b28c8ad`). Reviewer verdict was
"Ready to merge? Yes"; this design covers the recorded non-blocking follow-ups.

Linked bead: `pi-packages-28v` (chore, P3). Molecule: `pi-packages-mol-wqd`.

## Scope

Six items, five documentation-only and one defensive script hardening. No
architectural change; the task-bead model from R4/R5/R8 stands.

| # | File | Change |
|---|------|--------|
| 1 | `subagent-driven-development/SKILL.md` | Sweep `plan text` → `task text` at lines 68 (diagram node), 97/98/100 (edge labels → `"Finding conflicts with task text?"`), 169, 292, 349. **Preserve** "plan" as the bead-graph noun (read plan, plan-mandated, plan defect) |
| 2 | `writing-plans/SKILL.md:247` | Correct stale cross-ref: `executing-plans` Step 3, "Rewrite Complete Development" → **Step 5, "Complete Development"** (Step 3 of executing-plans is "Report") |
| 3 | `writing-plans/SKILL.md:250` | Grammar: "Hand execution the **implement step id** —" → "Hand the **implement step id** over to execution —" |
| 4 | `subagent-driven-development/scripts/sdd-workspace` | Harden slug guard: reject `/`, `\`, leading `_` in addition to empty/`.`/`..`; fail loudly (`exit 2`) |
| 5 | `brainstorming/SKILL.md:185` | Double-hyphen `--` → em-dash `—` (U+2014) in "itself -- e.g." |
| 6 | `implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md` | Strip literal backticks inside the fenced `Agent({ prompt: `...` })` examples (`` `bd show <TASK_ID>` `` → `bd show <TASK_ID>`) so the block is safe to copy into a JS template literal; instruction text unchanged |

## Decisions (from clarifying Q&A)

- **Item 1 — R5-totality:** Full sweep of *"plan text"* collocations to *"task text"*.
  The phrase was the last residual that could picture a plan *document* that no
  longer exists (the plan is now the bead graph; its text is the task-bead
  descriptions). Legitimate uses of "plan" as the bead-graph noun are retained:
  "read the plan", "plan-mandated", "plan defect".
- **Item 4 — Slug guard:** Tight guard (reject `/`, `\`, leading `_`) rather than a
  strict `[A-Za-z0-9-]` whitelist. `/` is the load-bearing path-segment escape on
  Unix (closes embedded traversal of `.superpowers/sdd/`); `_` and `\` are
  belt-and-suspenders. A strict whitelist would couple the script to bd's exact
  current id format and is more than the threat justifies. Slugs are controlled
  implement-step ids today, so this is defense-in-depth — no real-world impact.
- **Item 6 — Template backticks:** Included in scope. Templates are meant to be
  consumed, so consumption-safety (copy-paste into a JS template literal) beats
  Markdown inline-code prettiness.
- **Delivery:** Approach 1 — two commits on `feat/skills-text`: Commit A = items
  1, 2, 3, 5, 6 (doc-only); Commit B = item 4 (script guard, independently
  revertable). Then re-run the code-reviewer against the branch, then merge to main.

## Behavior & error handling

No runtime change except the slug guard now rejects a wider set of malformed
slugs, loudly (`echo … >&2; exit 2`). Because slugs are machine-generated
implement-step ids (always lowercase/digits/hyphens), no real slug is affected.
This closes an embedded-traversal footgun (directory + review-artifact writes out
of `.superpowers/sdd/`) for near-zero cost.

## Testing

1. `grep -n "plan text\|plan's text"` on `subagent-driven-development/SKILL.md` → empty.
2. `grep -n "Rewrite Complete Development\|Hand execution"` on
   `writing-plans/SKILL.md` → empty.
3. `./scripts/sdd-workspace` with `""`, `.`, `..`, `/etc`, `_x`, and a valid id →
   all malformed inputs `exit 2` with a message on stderr; valid id prints the plan dir.
4. `grep -n '\`bd show'` (literal backtick) on the three prompt templates under
   `subagent-driven-development/` → no matches remain.
5. Confirm `brainstorming/SKILL.md` has no stray double-hyphen `-- ` in prose
   (frontmatter `---` allowed).
