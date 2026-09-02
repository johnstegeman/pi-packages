# Upstream Sync Analysis: obra/superpowers → pi-superpowers-plus

**Goal:** Identify changes made in the original `obra/superpowers` skills since this
project was converted from them, and assess which of those changes can be brought
into this fork.

**Chain:** `obra/superpowers` (original) → `coctostan/pi-superpowers` (upstream) →
this repo (`johnstegeman/pi-superpowers-plus`).

---

## Methodology

1. **Found the conversion point.** Upstream's earliest commits (`7a32bc5` "copy
   reference files from upstream superpowers" … `047fca3` "add receiving-code-review
   skill adapted for pi") all land on **2026-02-08**. Each skill was copied then
   "adapted for pi" in a separate commit.
2. **Snapshotted the original at conversion time.** The matching `obra/superpowers`
   commit is **`a98c5df`** (v4.2.0, 2026-02-05) — the last original release before
   the conversion.
3. **Diffed `obra/superpowers` `skills/` between `a98c5df..HEAD`** to get the exact
   delta since conversion: **175 commits**, ~3,800 insertions / ~1,250 deletions
   across 42 files.
4. **Compared fork HEAD vs original HEAD** per file, and **fork HEAD vs conversion
   snapshot** to distinguish "fork modified it" from "fork kept it pristine".

Key fact: the fork's `skills/*/SKILL.md` files are **heavily diverged** from the
original (43–558 differing lines each) because of pi-adaptations (`/skill:`
invocation syntax, "Related skills" lines, extension references, the
`docs/superpowers/{specs,plans}` path convention) **and** because the fork retained
some content the original later deleted. So SKILL.md changes need **per-file
three-way merges**, never wholesale copies.

---

## The delta at a glance

| Kind | Count | Examples |
|------|-------|----------|
| Entirely new skills never ported | 2 | `using-superpowers`, `writing-skills` |
| New support files (scripts/prompts/references) | ~10 | visual companion server, SDD scripts, reviewer prompts, `pi-tools.md` |
| File replacements (original deleted files the fork still carries) | 3 | `testing-anti-patterns.md` → `writing-good-tests.md`; `spec-reviewer-prompt.md` + `code-quality-reviewer-prompt.md` → `task-reviewer-prompt.md` + `re-review-prompt.md` |
| SKILL.md content changes | 14 | compression sweep + feature content |
| Clean bug-fixes to shared files | 1 | `find-polluter.sh` |

---

## Tier 1 — Clean / high-value ports (low conflict)

### 1.1 `systematic-debugging/find-polluter.sh` bug fixes
- Fork's copy is **pristine** (identical to the conversion snapshot).
- Original has **2 bug-fix commits** since conversion:
  - `6015d37` match `find -path ./` prefix
  - `c8921b5` accept `./`-prefixed patterns and match top-level tests
- **Action:** copy original HEAD's `find-polluter.sh` verbatim. Pure win, ~12 lines
  changed, no merge conflict.

### 1.2 `test-driven-development/writing-good-tests.md` (replaces `testing-anti-patterns.md`)
- Fork still carries `testing-anti-patterns.md` **unchanged from the conversion
  snapshot**. The original deleted it and shipped a ground-up, two-principle rewrite:
  `writing-good-tests.md` (198 lines, harness-agnostic).
- Original commits: reframe as "writing-good-tests", broaden trigger to any test
  writing, absorb falsifiability discipline, close the change-detector hole,
  compress additions.
- **Action:** add `writing-good-tests.md` as a new reference. Wire it into
  `test-driven-development/SKILL.md` and (if applicable) the workflow-monitor
  reference topics. Decide whether to retire `testing-anti-patterns.md` or keep
  both. High value, low conflict (new file + a few SKILL.md link edits).

### 1.3 Trivial edits to shared reference files
- `systematic-debugging/root-cause-tracing.md` and `CREATION-LOG.md`: 2-line edits
  each since conversion. `root-cause-tracing.md` is used by the fork's
  workflow-monitor (`debug-tracing` topic) — apply the tiny edit.
- (Fork does not carry `CREATION-LOG.md`; skip.)

---

## Tier 2 — New skills / support files (self-contained, need light pi-adaptation)

### 2.1 `using-superpowers` skill + `references/pi-tools.md`
- **Never ported.** The original's bootstrap skill: "invoke relevant skills before
  any response." Contains a Red Flags rationalization table, skill-priority rules,
  and user-instructions precedence.
- **Already has a pi-specific reference:** `references/pi-tools.md` (16 lines) maps
  skill actions ("dispatch a subagent", "create a todo") to pi tools and explicitly
  mentions the `pi-subagents` package.
- **Caveat — overlap with fork's enforcement model:** the fork enforces
  skill-usage via the `workflow-monitor` extension and pi's native skill discovery,
  so parts of this skill are redundant. Still, the Red Flags table + priority rules
  are valuable.
- **Action:** port `SKILL.md` (62 lines) trimmed to pi only — keep the `pi-tools.md`
  Platform Adaptation entry, drop Codex/Antigravity/Gemini entries (or keep them
  only if multi-harness support is wanted). Add `references/pi-tools.md`. Skip the
  other-harness reference files.

### 2.2 Reviewer prompt templates (`spec-document-reviewer-prompt.md`, `plan-document-reviewer-prompt.md`)
- Two small (49-line each) harness-agnostic prompt templates for dispatching a
  spec-review and a plan-review subagent. Use the `Subagent (general-purpose):`
  dispatch shape.
- **Convergence bonus:** they reference `docs/superpowers/specs/` — the **same**
  path convention the fork just adopted (commit `f06acf3`).
- **Caveat — overlap:** the fork already has `subagent-driven-development/spec-reviewer-prompt.md`
  and `code-quality-reviewer-prompt.md` (which the fork modified, and the original
  later **deleted**). These new templates are about reviewing the **documents**
  (spec/plan), not the implementation, so they're complementary, not duplicates.
- **Action:** port both, adapting the dispatch syntax to the fork's subagent
  extension format. Wire into `brainstorming/SKILL.md` (spec review loop) and
  `writing-plans/SKILL.md` (plan review loop).

### 2.3 SDD helper scripts (`sdd-workspace`, `task-brief`, `review-package`)
- 3 new bash scripts (40+41+46 lines), harness-agnostic, `#!/usr/bin/env bash`.
  Implement a plan-scoped workspace (`.superpowers/sdd/<plan>/`), per-task brief
  extraction, and review-package (diff) generation.
- **Caveat — directory convention:** original uses `.superpowers/sdd/<plan>/`;
  fork uses `docs/superpowers/{specs,plans}`. Scripts need path adaptation.
- **Caveat — subagent model:** scripts pair with the original's reworked
  subagent-driven-development lifecycle (see 2.4).
- **Action:** portable but only worth it if adopting the SDD rework (Tier 2.4).
  Medium effort.

### 2.4 SDD reviewer-model consolidation (`task-reviewer-prompt.md` + `re-review-prompt.md`)
- The original **deleted** `spec-reviewer-prompt.md` and `code-quality-reviewer-prompt.md`
  (which the fork still carries and has **modified**) and replaced them with a
  unified `task-reviewer-prompt.md` (185 lines) + scoped `re-review-prompt.md`
  (106 lines), plus a major `subagent-driven-development/SKILL.md` rework
  (563 lines churn: resume-based fix loop, five-round breaker, plan-scoped
  workspace, rationalization table).
- **This is a design divergence, not a clean port.** The fork invested in its own
  reviewer prompts; the original took a different direction (merge per-task
  reviews into one task reviewer + scoped re-review + durable progress ledger).
- **Action:** requires a **decision** — adopt the original's consolidated
  reviewer model + SDD lifecycle, or keep the fork's split. If adopting, this is a
  large coordinated change (SKILL.md + 2 new prompts + 3 scripts + delete 2 old
  prompts). If not, skip and keep the fork's model. Either way, capture the
  original's reviewer-skepticism / no-pre-judging discipline as content improvements.

---

## Tier 3 — Large self-contained feature (port only if wanted)

### 3.1 Brainstorming visual companion
- A browser-based visual brainstorming tool: zero-dependency Node HTTP/WebSocket
  server (`server.cjs`, 723 lines) + bash launchers (`start-server.sh` 209,
  `stop-server.sh` 120) + guide (`visual-companion.md`, 298 lines). Harness-agnostic
  standalone server; stores under `.superpowers/brainstorm/`.
- Pairs with `brainstorming/SKILL.md` changes (hard gates, spec review loop,
  architecture guidance, capability-aware escalation).
- **Action:** only if the feature is desired. ~1,350 lines + SKILL.md integration.
  Medium-high effort. Needs path-convention adaptation (`docs/superpowers/` vs
  `.superpowers/`) and a decision on browser-launch handling.

---

## Tier 4 — SKILL.md content merges (high-touch, per-file three-way merge)

The original changed all 14 `SKILL.md` files (912 ins / 687 del). Two themes:

**A. Compression sweep (v6.2.0)** — a deliberate leaner-content philosophy:
- Drop "The Bottom Line" / "Remember" recap sections (receiving-code-review,
  writing-skills, writing-plans).
- Drop persuasion / social-proof sections (verification-before-completion,
  systematic-debugging, dispatching-parallel-agents).
- Convert guard sections → **rationalization tables** (using-git-worktrees,
  finishing-a-development-branch, requesting-code-review).
- Fold Integration / Related-skills lists "into points of use"
  (systematic-debugging, dispatching-parallel-agents).
- *Judgment call:* the fork **retained** some of these (e.g. "The Bottom Line" in
  receiving-code-review). Decide whether to adopt the original's leaner style or
  keep the fork's recap sections.

**B. Feature / process content** — valuable, must merge against fork's pi-adapted
versions (do **not** copy wholesale):
- `brainstorming`: hard gates + process flow, spec review loop, user review gate
  between spec and plan, architecture guidance, capability-aware escalation,
  project-level scope assessment.
- `writing-plans`: task right-sizing, Global Constraints header, per-task
  Interfaces blocks, plan review loop, checkbox syntax, 4-backtick nested fences.
- `finishing-a-development-branch`: forge-agnostic PR creation, stop offering to
  discard work, rationalization table, compression.
- `executing-plans`: remove batch-and-stop pattern, trim subagent quality claim.
- `dispatching-parallel-agents`: context isolation principle, drop social proof.
- `requesting-code-review` / `code-reviewer.md`: trim, review-guards table.
- `systematic-debugging`: fold Related-skills into Phase 4, drop social proof.
- `verification-before-completion`: drop persuasion sections.
- `using-git-worktrees`: rationalization table, capture worktree path before
  Step 5 changes directory (real bug fix), portable shebang.

**Action:** merge per skill, in priority order, preserving fork pi-adaptations
(`/skill:` syntax, Related skills lines, extension refs, `docs/superpowers/`
paths) while adopting the original's substantive process improvements. The
worktree-path-capture fix in `using-git-worktrees` is a real bug fix worth taking
regardless of the larger merge.

---

## Not applicable / skip

- `using-superpowers/references/{codex,gemini,antigravity}-tools.md` — other
  harnesses (skip unless multi-harness support is wanted).
- `writing-skills` skill (679-line SKILL.md + support files) — meta-skill for
  **authoring** skills. Useful for contributors extending this repo, not end-users.
  Low priority; port only if a skill-authoring guide is wanted.
- `systematic-debugging/{CREATION-LOG.md,test-academic.md,test-pressure-1..3.md}`
  — original-internal test fixtures/logs; not useful in the fork.

---

## Recommended porting order

1. **`find-polluter.sh`** — trivial, pure win (Tier 1.1).
2. **`writing-good-tests.md`** + TDD SKILL.md wiring — clean, high value (Tier 1.2).
3. **`root-cause-tracing.md`** 2-line edit (Tier 1.3).
4. **`using-superpowers` + `pi-tools.md`** trimmed to pi (Tier 2.1).
5. **Spec/plan document reviewer prompt templates** (Tier 2.2).
6. **Decision: SDD reviewer-model consolidation** (Tier 2.4) — decide fork's
   direction first; if adopting, port scripts + prompts + SKILL.md together
   (Tier 2.3).
7. **SKILL.md content merges**, per skill, batched — prioritise the real bug fixes
   (`using-git-worktrees` worktree-path capture) and high-value process content
   (brainstorming gates, writing-plans structure) (Tier 4).
8. *(Optional)* **brainstorming visual companion** (Tier 3.1) — only if the
   feature is wanted.
9. *(Optional)* **`writing-skills`** — only if a skill-authoring guide is wanted.

---

## Data sources

- Original: `obra/superpowers` @ HEAD (v6.2.0, 2026-07-23); conversion snapshot
  `a98c5df` (v4.2.0, 2026-02-05).
- Upstream conversion commits: `7a32bc5`…`047fca3` (2026-02-08).
- Delta: `git diff a98c5df..HEAD -- skills/` in `obra/superpowers` = 175 commits,
  42 files.
