# set_phase Observability Tool & Skill Amendments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register a `set_phase` tool that emits `{ phase }` on the `superpowers:phase` EventBus channel, and add a `set_phase` call instruction to each of the six phase-boundary skills.

**Architecture:** A single pi extension (`extensions/set-phase.ts`) registers the tool via `pi.registerTool()`. The tool's `execute` emits `pi.events.emit("superpowers:phase", { phase })` and returns empty content. Six `SKILL.md` files each gain one short call-at-start instruction with the exact phase value. `package.json` declares the extension directory and the bundled-core `peerDependencies`.

**Tech Stack:** TypeScript, pi Extension API (`@earendil-works/pi-coding-agent` — `ExtensionAPI`, `pi.registerTool`, `pi.events`), `typebox` (`Type.String`), Biome for lint (`biome check .`).

**Design spec:** `docs/superpowers/specs/2026-08-05-set-phase-observability-design.md`

## Global Constraints

- Event channel is exactly `superpowers:phase`; emitted payload is exactly `{ phase: <string> }` — no timestamp, no session id, no other fields.
- No deduplication: every `set_phase` call emits unconditionally.
- Tool name is exactly `set_phase`; single parameter `phase: string` (any string accepted, not an enum).
- Tool `execute` returns empty content: `{ content: [{ type: "text", text: "" }], details: {} }`.
- Tool `description` steers non-superpowers skills away (must mention it is part of the Superpowers workflow and only Superpowers skills should call it with `brainstorming` / `development`).
- Manifest: `package.json` `pi.extensions` must include `./extensions`; `files` must include `extensions/` so it ships on npm; `peerDependencies` must declare the bundled core packages (`@earendil-works/pi-coding-agent`, `typebox`) with `"*"` ranges per `packages.md`.
- Six skills in scope, each gains ONE call at skill start with its exact value:
  - `brainstorming`, `writing-plans` → `set_phase({ phase: "brainstorming" })`
  - `executing-plans`, `subagent-driven-development`, `requesting-code-review`, `receiving-code-review` → `set_phase({ phase: "development" })`
- Supporting skills (TDD, debugging, verification, worktrees, parallel agents, finishing) are NOT amended.
- Verification: `biome check .` must pass (exit 0, 0 errors). No unit-test harness exists for extensions in this package (per spec) — verification is `biome check`, manifest grep checks, and a grep that all six skills contain their call.

---

### Task 1: `set_phase` extension + package manifest

**Files:**
- Create: `extensions/set-phase.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: tool `set_phase(phase: string)` that emits `{ phase }` on `superpowers:phase` via `pi.events.emit`, returns empty content. Tasks 2-3 depend on the tool existing so the skills can call it.

- [ ] **Step 1: Create the extension**

Create `extensions/set-phase.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "set_phase",
		label: "Set Phase",
		description:
			"Emit the current Superpowers workflow phase on the superpowers:phase event bus channel for observability (e.g. cost tracking by phase). Pass `brainstorming` during brainstorming or planning, `development` during implementation or code review. Only the Superpowers skills should call this — do not use it for ordinary work.",
		parameters: Type.Object({
			phase: Type.String({
				description:
					"The workflow phase. Superpowers skills pass `brainstorming` or `development`. Accepts any string for future extension.",
			}),
		}),
		async execute(_toolCallId, params) {
			pi.events.emit("superpowers:phase", { phase: params.phase });
			// Minimal return so the model's own narration stays uninterrupted.
			return {
				content: [{ type: "text", text: "" }],
				details: {},
			};
		},
	});
}
```

- [ ] **Step 2: Update `package.json`**

Make three additions (keep a valid JSON object; do not disturb the existing `skills` entry):

1. Add `"extensions": ["./extensions"]` to the `"pi"` block, alongside the existing `"skills"`:
   ```json
   "pi": {
     "extensions": ["./extensions"],
     "skills": ["skills"]
   }
   ```
2. Add `"extensions/"` to the top-level `"files"` array (alongside `"agent-templates/"`, `"skills/"`, `"banner-plus.jpg"`, `"LICENSE"`, `"README.md"`).
3. Add a top-level `"peerDependencies"` block (bundled core packages, per `packages.md`):
   ```json
   "peerDependencies": {
     "@earendil-works/pi-coding-agent": "*",
     "typebox": "*"
   }
   ```

- [ ] **Step 3: Lint + JSON validity**

Run: `biome check .`
Expected: PASS (exit 0, 0 errors). The tab-indented file above matches biome's default style; if biome reports a formatting deviation, apply `biome check --write extensions/set-phase.ts` and re-run.

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('valid json')"`
Expected: prints `valid json`.

- [ ] **Step 4: Verify manifest**

Run:
```bash
node -e "const p=require('./package.json'); console.log('pi.extensions', JSON.stringify(p.pi.extensions)); console.log('files includes extensions/', p.files.includes('extensions/')); console.log('peerDeps', JSON.stringify(p.peerDependencies))"
```
Expected:
```
pi.extensions ["./extensions"]
files includes extensions/ true
peerDeps {"@earendil-works/pi-coding-agent":"*","typebox":"*"}
```

- [ ] **Step 5: Optional smoke test**

If a pi environment is available, load the package and confirm the event fires: `pi -e .` then invoke `set_phase` and observe a listener on `superpowers:phase`. If no environment is available, note this in the report and move on — the extension's correctness is verified by lint + manifest checks and the code review.

- [ ] **Step 6: Commit**

```bash
git add extensions/set-phase.ts package.json
git commit -m "feat: add set_phase tool emitting superpowers:phase events"
```

---

### Task 2: `brainstorming` + `writing-plans` emit `brainstorming`

**Files:**
- Modify: `skills/brainstorming/SKILL.md`
- Modify: `skills/writing-plans/SKILL.md`

**Interfaces:**
- Consumes: `set_phase(phase)` tool from Task 1.
- Produces: skills that announce `brainstorming` at start. Task 3 mirrors this pattern for the four `development` skills.

- [ ] **Step 1: Add the call to `brainstorming/SKILL.md`**

In the intro, after the line

```
Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design and get user approval.
```

insert a new line (before the `<HARD-GATE>` block):

```
At the start of the skill, call `set_phase({ phase: "brainstorming" })`.
```

The surrounding text must remain unchanged.

- [ ] **Step 2: Add the call to `writing-plans/SKILL.md`**

In the Overview, directly after the existing line

```
**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."
```

add a new line:

```
Call `set_phase({ phase: "brainstorming" })` — this is still the brainstorming phase.
```

- [ ] **Step 3: Verify both edits**

Run:
```bash
grep -n 'set_phase({ phase: "brainstorming" })' skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md
```
Expected: exactly one match in each file (lines 2 total).

Run: `biome check .`
Expected: PASS (exit 0, 0 errors).

- [ ] **Step 4: Commit**

```bash
git add skills/brainstorming/SKILL.md skills/writing-plans/SKILL.md
git commit -m "feat: emit brainstorming phase in brainstorming and writing-plans skills"
```

---

### Task 3: the four `development` skills emit `development`

**Files:**
- Modify: `skills/executing-plans/SKILL.md`
- Modify: `skills/subagent-driven-development/SKILL.md`
- Modify: `skills/requesting-code-review/SKILL.md`
- Modify: `skills/receiving-code-review/SKILL.md`

**Interfaces:**
- Consumes: `set_phase(phase)` tool from Task 1.
- Produces: the four development-phase skills announce `development` at start.

- [ ] **Step 1: `executing-plans/SKILL.md`**

Directly after the existing line

```
**Announce at start:** "I'm using the executing-plans skill to implement this plan."
```

add:

```
Call `set_phase({ phase: "development" })`.
```

- [ ] **Step 2: `subagent-driven-development/SKILL.md`**

At the top of the `## Setup` section, before the first paragraph ("Ensure the work happens in an isolated workspace..."), add a new line:

```
Call `set_phase({ phase: "development" })` at the start of the skill.
```

- [ ] **Step 3: `requesting-code-review/SKILL.md`**

In the intro, directly after the `**Core principle:** Review early, review often.` line, add:

```
Call `set_phase({ phase: "development" })` — code review is still the development phase.
```

- [ ] **Step 4: `receiving-code-review/SKILL.md`**

In the Overview, directly after the `**Core principle:** Verify before implementing. Ask before assuming. Technical correctness over social comfort.` line, add:

```
Call `set_phase({ phase: "development" })` — code review is still the development phase.
```

- [ ] **Step 5: Verify all four edits**

Run:
```bash
grep -rn 'set_phase({ phase: "development" })' skills/executing-plans/SKILL.md skills/subagent-driven-development/SKILL.md skills/requesting-code-review/SKILL.md skills/receiving-code-review/SKILL.md
```
Expected: exactly one match in each of the four files (4 lines total).

Run: `biome check .`
Expected: PASS (exit 0, 0 errors).

- [ ] **Step 6: Commit**

```bash
git add skills/executing-plans/SKILL.md skills/subagent-driven-development/SKILL.md skills/requesting-code-review/SKILL.md skills/receiving-code-review/SKILL.md
git commit -m "feat: emit development phase in development and code-review skills"
```

---

### Task 4: Final verification + cross-check against spec

**Files:**
- Modify: none (verification only)

**Interfaces:**
- Consumes: Tasks 1-3 complete.

- [ ] **Step 1: Grep all six skills**

Run:
```bash
grep -rln 'set_phase({ phase: ' skills/
```
Expected: exactly the six in-scope skills listed (brainstorming, writing-plans, executing-plans, subagent-driven-development, requesting-code-review, receiving-code-review). No supporting skill should appear.

- [ ] **Step 2: Full lint + manifest**

Run: `biome check .` → PASS (exit 0, 0 errors).

Run:
```bash
node -e "const p=require('./package.json'); if(!p.pi.extensions.includes('./extensions')) throw new Error('extensions missing'); if(!p.files.includes('extensions/')) throw new Error('files missing extensions/'); console.log('manifest OK')"
```
Expected: prints `manifest OK`.

- [ ] **Step 3: Confirm only in-scope files changed**

Run: `git diff --stat HEAD~4`
Expected: only `extensions/set-phase.ts`, `package.json`, and the six `SKILL.md` files appear (plus this plan + spec committed earlier).

- [ ] **Step 4: Cross-check against spec table**

Confirm every row of the design spec's six-skill table has a matching `set_phase(...)` call with the right value, and that supporting skills are untouched (no matches). If any gap: fix it, re-run Steps 1-2.

- [ ] **Step 5: Report**

Summarize: tool registered; manifest updated; six skills each carry one call; lint green. No commit needed (verification only).
