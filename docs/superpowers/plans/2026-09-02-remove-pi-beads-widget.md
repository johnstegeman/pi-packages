# Remove pi-beads widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the above-editor board widget from `packages/pi-beads` while keeping the ten `beads_*` tools, umbrella multi-repo routing, lean prime, `bd✓`/`bd✗` status-line segment, all four `/beads*` commands, and the bundled `beads` skill byte-for-byte functional.

**Architecture:** Pure deletion. The widget is a leaf — no other code in the extension depends on its state — so the work is stripping ~220 lines of widget machinery from `src/index.ts`, deleting the widget-only source/test/docs/script files, and updating manifest + docs. No migration, no new features, no version bump.

**Tech Stack:** TypeScript loaded as ESM via Node type-stripping (Node ≥22.6), `bd` CLI on PATH, git. No build step. No test framework (all tests removed by design).

**Spec:** `docs/superpowers/specs/2026-09-02-remove-pi-beads-widget-design.md` (approved).

## Global Constraints

- Keep `name` and `version` (`0.2.2`) unchanged in `packages/pi-beads/package.json`.
- Keep, **unchanged in behavior**: all 10 `beads_*` tools, umbrella topology/routing/`ensureFresh`, `buildPrimeBlock` (lean prime + focus), `setStatusLine` (the `bd✓`/`bd✗` status segment), all four `/beads*` commands, and the `resources_discover` skill registration.
- No new features; no refactoring beyond the deletion.
- Grep verification is scoped to `packages/pi-beads/src`, `packages/pi-beads/package.json`, `packages/pi-beads/README.md`, and root `AGENTS.md`. The design/plan docs under `docs/superpowers/` legitimately mention "widget" — do **not** try to strip those.
- One commit per task; each task ends verifiable.
- All commands run from the repo root: `/Users/jstegeman/orca/workspaces/pi-packages/remove-pi-beads-widget`.

---

### Task 1: Strip the widget from `src/index.ts`, delete widget renderer + manifest wiring

**Files:**
- Modify: `packages/pi-beads/src/index.ts` (multiple deletions — locate each by content, not line number; line numbers will shift as you delete)
- Delete: `packages/pi-beads/src/widget-lines.mjs`
- Delete: `packages/pi-beads/src/widget-lines.test.mjs`
- Modify: `packages/pi-beads/package.json`

**Interfaces:**
- Consumes: nothing new (pure deletion).
- Produces: `src/index.ts` with zero references to the widget; the package's `main`/`exports` (`./src/index.ts`) and `pi.extensions`/`pi.skills` manifest entries unchanged and valid; no remaining file references to the two deleted `widget-lines.*` files.

- [ ] **Step 1: Remove the widget import**

Delete this exact line from `src/index.ts`:

```ts
import { widgetLines, formatAge, parseClosedWisps } from "./widget-lines.mjs";
```

Verify: `grep -n "widget-lines" packages/pi-beads/src/index.ts` → no output.

- [ ] **Step 2: Remove the widget state block**

Delete this exact block (it follows `let defaultRepoDir: string | null = null; ...` and precedes `let beadsReady = false;`):

```ts
  // ---- in-session "in progress" widget state (memory only, no disk, no polling) ----
  let uiRef: any = null; // ctx.ui captured at session_start; absent in subagents/workflows
  type WipEntry = {
    repo: string;
    title: string;
    priority?: number;
    startedAt?: string;
  };
  const wip = new Map<string, WipEntry>();
  // open + unblocked across all known repos incl. wisps ("to do"); refreshed on
  // the same cadence as readyCount (session start + after writes, never a timer)
  const todo = new Map<string, WipEntry>();
  // done: closed wisps currently in the DB, refetched at session start, after
  // beads_* writes, and on EVERY agent_start — so bare-`bd` changes (incl.
  // superpowers' phase-end `bd mol wisp gc --closed --force`) show up within a
  // turn. Purging the wisps empties the list; there is no in-memory accumulator.
  const done = new Map<string, WipEntry>();
  let readyCount: number | null = null; // null => the segment is omitted, never "0"
```

- [ ] **Step 3: Simplify `afterWrite`**

Replace this block:

```ts
  // after a routed write: re-export the repo's JSONL so the next `repo sync` sees it
  async function afterWrite(repoDir: string): Promise<void> {
    // any write can change what is ready or done; refresh off the critical path
    // so the extra subprocesses never show up as tool latency (still no timers)
    void Promise.allSettled([refreshReady(), refreshDone()]).then(
      () => renderWip(),
      () => {},
    );
    if (!isUmbrella) return; // single-repo: same DB the reads use, nothing to sync
    await bd(["export", "-o", ".beads/issues.jsonl"], repoDir, 30000);
    needSync = true;
  }
```

with:

```ts
  // after a routed write: re-export the repo's JSONL so the next `repo sync` sees it
  async function afterWrite(repoDir: string): Promise<void> {
    if (!isUmbrella) return; // single-repo: same DB the reads use, nothing to sync
    await bd(["export", "-o", ".beads/issues.jsonl"], repoDir, 30000);
    needSync = true;
  }
```

- [ ] **Step 4: Delete the whole widget section**

Locate the block start: `grep -n "in-progress widget" packages/pi-beads/src/index.ts` → the line `// ---- in-progress widget ----`.

Locate the block end: `grep -n "============ lifecycle" packages/pi-beads/src/index.ts` → the banner `// ============ lifecycle ============`.

Delete everything from the `// ---- in-progress widget ----` line up to (but NOT including) the `// ============ lifecycle ============` line. This removes, in order: `widgetState()`, `renderWip()`, `refreshReady()`, `refreshDone()`, `metaOf()`, and `loadWip()` — the full region between `setStatusLine()`'s closing brace and the lifecycle banner.

Verify after: `grep -nE "widgetState|renderWip|refreshReady|refreshDone|metaOf|loadWip|setWidget|formatAge|parseClosedWisps" packages/pi-beads/src/index.ts` → no output.

- [ ] **Step 5: Slim `session_start`**

Replace this block:

```ts
  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      activeCwd = ctx?.cwd ?? process.cwd();
      uiRef = ctx?.ui ?? null;
      await resolveTopology();
      setStatusLine(ctx);
      if (beadsReady) {
        // fire-and-forget: bd must not delay session start
        void Promise.allSettled([loadWip(), refreshReady(), refreshDone()]).then(
          () => renderWip(),
          () => {
            /* bd missing/broken -> widget just stays empty */
          },
        );
      } else {
        // /reload back into an uninitialized state: drop a stale widget
        wip.clear();
        todo.clear();
        done.clear();
        renderWip();
      }
    } catch (e: any) {
      ctx?.ui?.notify?.(
        `pi-beads-lean init failed: ${e?.message ?? e}`,
        "error",
      );
    }
  });
```

with:

```ts
  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      activeCwd = ctx?.cwd ?? process.cwd();
      await resolveTopology();
      setStatusLine(ctx);
    } catch (e: any) {
      ctx?.ui?.notify?.(
        `pi-beads-lean init failed: ${e?.message ?? e}`,
        "error",
      );
    }
  });
```

- [ ] **Step 6: Delete the `agent_start` handler**

Delete this whole block (it immediately follows the `session_start` handler):

```ts
  pi.on("agent_start", async () => {
    // Re-read the closed-wisp list every turn within a beads session: superpowers
    // mutates the DB with bare `bd` calls (closes mid-phase, and ends the phase
    // with `bd mol wisp gc --closed --force`) that never reach the beads_*
    // tools, so the re-read stays unconditional there. Outside a beads session
    // there is nothing to read — skip the `bd mol wisp list` spawn entirely.
    // Fire-and-forget so this never blocks the turn.
    if (!beadsReady) return;
    void refreshDone().then(() => renderWip(), () => {});
  });
```

Verify: `grep -n "agent_start" packages/pi-beads/src/index.ts` → the only hit is in `before_agent_start` later in the file. (That one stays.)

- [ ] **Step 7: Remove the widget mutation in `beads_update`**

Replace this block:

```ts
      if (params.status) {
        const id = String(params.id);
        todo.delete(id); // whatever the new status, it is no longer "to do"
        if (String(params.status) === "in_progress") {
          const meta = await metaOf(id, repoDir);
          wip.set(id, {
            repo: path.basename(repoDir),
            title: String(params.title ?? "") || meta.title || "",
            priority: Number.isFinite(params.priority)
              ? Number(params.priority)
              : meta.priority,
            startedAt: meta.startedAt,
          });
        } else {
          wip.delete(id);
        }
        renderWip();
      }
      return textResult(r.out.trim() || "updated");
```

with:

```ts
      return textResult(r.out.trim() || "updated");
```

(The `await afterWrite(repoDir);` line just above is kept.)

- [ ] **Step 8: Remove the widget mutation in `beads_close`**

Replace this block:

```ts
      // drop what really got closed even on a partial failure, so a failed close
      // never leaves the widget showing an item that is still open
      for (const id of closedIds) {
        wip.delete(id);
        todo.delete(id);
      }
      // the DB-derived done list (incl. the just-closed wisps, titles intact) is
      // repainted by afterWrite -> refreshDone as soon as that read lands.
      renderWip();
      if (failure) return textResult(failure);
      return textResult(`closed ${closedIds.join(", ")}`);
```

with:

```ts
      if (failure) return textResult(failure);
      return textResult(`closed ${closedIds.join(", ")}`);
```

(`closedIds` is still collected in the loop above and used in the return — keep that.)

- [ ] **Step 9: Delete the widget source + test files**

```bash
git -C /Users/jstegeman/orca/workspaces/pi-packages/remove-pi-beads-widget rm \
  packages/pi-beads/src/widget-lines.mjs \
  packages/pi-beads/src/widget-lines.test.mjs
```

- [ ] **Step 10: Update `package.json`**

In `packages/pi-beads/package.json`:

- `description`: change
  `"...writes, an in-progress widget, and a bundled beads skill."`
  to
  `"...writes, and a bundled beads skill."`
  (i.e., delete the `an in-progress widget, ` segment so the full value reads:
  `"Context-lean beads (bd) task tracking for pi: compact beads_* tools, once-per-segment lean prime, umbrella multi-repo reads with prefix-routed writes, and a bundled beads skill."`)
- `files`: remove `"src/widget-lines.mjs",` → `["src/index.ts", "skills", "README.md", "LICENSE"]`
- `pi`: remove the `image` line → `{ "extensions": ["./src/index.ts"], "skills": ["./skills"] }`
- `scripts`: remove the `test` entry → `"scripts": {}`
- Leave `name`, `version` (`"0.2.2"`), `main`, `exports`, `peerDependencies`, `engines`, `publishConfig` unchanged.

Verify: `node -e "JSON.parse(require('fs').readFileSync('packages/pi-beads/package.json'))"` → exits 0.

- [ ] **Step 11: Verify the package core**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/remove-pi-beads-widget
grep -nE "widget|uiRef|setWidget|widgetLines|renderWip|WipEntry|readyCount|formatAge|parseClosedWisps|loadWip|refreshReady|refreshDone|metaOf" \
  packages/pi-beads/src packages/pi-beads/package.json
```
Expected: no output.

```bash
node --experimental-strip-types --check packages/pi-beads/src/index.ts
```
Expected: exits 0 (valid TS as pi loads it).

- [ ] **Step 12: Commit**

```bash
git add packages/pi-beads/src/index.ts packages/pi-beads/src/widget-lines.mjs packages/pi-beads/src/widget-lines.test.mjs packages/pi-beads/package.json
git commit -m "feat(pi-beads): remove the in-progress widget from the extension"
```

---

### Task 2: Delete widget-only artifacts

**Files:**
- Delete: `packages/pi-beads/scripts/` (contains only `widget-shots.mjs`)
- Delete: `packages/pi-beads/docs/` (contains only `shots.tape` and `assets/*.png`)
- Delete: `packages/pi-beads/SPEC-ui.md`
- Delete: `packages/pi-beads/Makefile` (only `help`/`test`/`shots` targets, all widget-centric)

**Interfaces:**
- Consumes: Task 1 (package core already widget-free).
- Produces: `packages/pi-beads/` containing only `src/index.ts`, `skills/`, `README.md`, `LICENSE`, `.gitignore`, `package.json`.

- [ ] **Step 1: Delete the artifacts**

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/remove-pi-beads-widget
git rm -r packages/pi-beads/scripts packages/pi-beads/docs
git rm packages/pi-beads/SPEC-ui.md packages/pi-beads/Makefile
```

- [ ] **Step 2: Verify the package is self-consistent**

```bash
find packages/pi-beads -type f -not -path "*/node_modules/*" | sort
```
Expected: exactly `src/index.ts`, `skills/beads/SKILL.md`, `README.md`, `LICENSE`, `.gitignore`, `package.json` (plus nothing else under `packages/pi-beads`).

Also confirm nothing references the deleted paths: `grep -rn "widget-shots\|shots.tape\|SPEC-ui\|Makefile" packages/pi-beads/package.json packages/pi-beads/README.md AGENTS.md` → no output.

- [ ] **Step 3: Commit**

```bash
git add -A packages/pi-beads
git commit -m "chore(pi-beads): drop widget screenshot pipeline, SPEC-ui.md, and Makefile"
```

---

### Task 3: Rewrite README and update AGENTS.md

**Files:**
- Modify: `packages/pi-beads/README.md`
- Modify: `AGENTS.md` (repo root)

**Interfaces:**
- Consumes: Task 1 + 2 (documentation reflects the now-widget-free package).
- Produces: `README.md` with no widget content; root `AGENTS.md` with no stale `npm test` reference for pi-beads.

- [ ] **Step 1: `README.md` header blurb**

Replace the last three lines of the intro paragraph:

```markdown
Next to the editor sits a widget of the current board — the issues in progress (◐), the
open/to-do ones (○, wisps included), and the ones just closed (✓). Not one of its lines
costs the model a token.
```

with:

```markdown
There is no always-on board next to the editor; `/beads` prints the ready +
in-progress view on demand, and the `beads_*` tools cover every query.
```

- [ ] **Step 2: Replace "What a session looks like"**

Delete the whole section (the `widget.png` figure, the "Every shot here is the real widget…" paragraph, and the "Besides the widget there is a status-line segment…" paragraph), and replace it with:

```markdown
## What a session looks like

The status line shows `bd✓` when beads is ready and `bd✗` when the project has no
`.beads/` directory. There is no board drawn beside the editor — run `/beads` to see the
ready + in-progress view, or use the `beads_*` tools.

An umbrella workspace, three issues in progress and one just closed, at 80 columns — the
information is the same as the widget's, but it appears in tool output and `/beads`, not
on screen.
```

- [ ] **Step 3: Delete "Widget legend"**

Delete the entire `## Widget legend` section (figure + the numbered list 1–7 explaining `⦿ beads`, counters, glyphs, priorities, repo column, age column, strike-through).

- [ ] **Step 4: Delete the "narrow pane" paragraph**

Delete the paragraph beginning `At most ten rows are drawn; when they overflow, to-do rows are evicted first...` and the `![The widget in a narrow pane](...)` line above it.

- [ ] **Step 5: Remove the Widget bullet from "How it works"**

Delete this bullet:

```markdown
**Widget.** Widget state lives in session memory: it shows the current board — what this
session has in progress, what is open/to-do (wisps included), and what it closed — and
repaints only that in-memory state in the UI process, so it costs no tokens.
```

Keep the **Prime.**, **Reads.**, and **Writes.** bullets.

- [ ] **Step 6: Trim "Limitations"**

Delete the two widget bullets:

```markdown
The widget exists only in pi's interactive interface. Subagents and workflow runs have no
UI context, so nothing is drawn there — the `beads_*` tools work as usual.

Widget state is session memory, but the done rows are read back from the database on
every turn, so changes made in another window or straight through `bd` (including a
phase-end `bd mol wisp gc --closed --force`) appear within a turn. At most ten rows are
drawn; to-do rows are evicted before done rows, and the rest collapse into a `+N` tail.
```

Keep the remaining two bullets (single-repo dependencies / no writes to the aggregate, and `bd` output format not being a stable contract).

- [ ] **Step 7: Rewrite "Development"**

Replace:

````markdown
## Development

```bash
make test     # node --test src/widget-lines.test.mjs
make shots    # re-render the README screenshots from the shipped code (needs vhs + imagemagick)
```

Source lives in `src/` and there is no build step: after editing, `/reload` in pi.
````

with:

````markdown
## Development

There is no build step and no automated test suite (the widget tests were removed with
the widget): after editing, `/reload` in pi.
````

(Keep the final "Licensed [MIT]…" line.)

- [ ] **Step 8: Update root `AGENTS.md`**

In the "Running tests" section, replace:

```markdown
- pi-beads tests: `cd packages/pi-beads && npm test`
```

with:

```markdown
- pi-beads has no automated tests (widget tests removed).
```

- [ ] **Step 9: Verify**

Note: the new narrative legitimately contains the bare words "widget" ("the same as the widget's"; "the widget tests were removed with the widget") and "✓" (`bd✓` statusline) — do NOT grep for those bare words. This grep targets leftover widget-**content** markers only.

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/remove-pi-beads-widget
grep -niE "widget\.png|widget-legend|widget-narrow|Widget legend|beads-wip|widget-shots|screenshot|◐|○|make test|make shots" packages/pi-beads/README.md AGENTS.md
```
Expected: no output.

```bash
grep -n "npm test" AGENTS.md | grep "pi-beads"
```
Expected: no output (statusline/langfuse `npm test` lines legitimately remain — only the pi-beads bullet was removed).

- [ ] **Step 10: Commit**

```bash
git add packages/pi-beads/README.md AGENTS.md
git commit -m "docs(pi-beads): document widget removal; drop stale test note from AGENTS.md"
```

---

### Task 4: Final verification + throwaway smoke

**Files:**
- Create (throwaway, NOT committed): `/tmp/pi-beads-smoke.mjs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: proof the extension still registers everything and nothing references the widget.

- [ ] **Step 1: Repo-scoped grep-zero**

Code + manifest must be strictly widget-free; docs gate targets leftover widget-**content** markers only (the bare words "widget"/"✓" legitimately occur in the approved narrative and the `bd✓` statusline):

```bash
cd /Users/jstegeman/orca/workspaces/pi-packages/remove-pi-beads-widget
# code + manifest: strict zero-widget
grep -rnE "widget|uiRef|setWidget|widgetLines|renderWip|WipEntry|readyCount|formatAge|parseClosedWisps|loadWip|refreshReady|refreshDone|metaOf" \
  packages/pi-beads/src packages/pi-beads/package.json
# docs: leftover widget content
grep -rnE "widget\.png|widget-legend|widget-narrow|Widget legend|beads-wip|widget-shots|screenshot|◐|○|make test|make shots" \
  packages/pi-beads/README.md AGENTS.md
```
Expected: no output from either.

- [ ] **Step 2: Type-strip parse of the extension**

```bash
node --experimental-strip-types --check packages/pi-beads/src/index.ts
```
Expected: exits 0.

- [ ] **Step 3: Write and run the throwaway smoke**

Write `/tmp/pi-beads-smoke.mjs`:

```js
// Throwaway load-smoke for pi-beads after widget removal. NOT committed.
// Asserts the factory registers the 10 tools, 4 commands, 1 skill, no widget.
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = "/Users/jstegeman/orca/workspaces/pi-packages/remove-pi-beads-widget";
const entry = pathToFileURL(path.join(ROOT, "packages/pi-beads/src/index.ts")).href;

const mod = await import(entry);

const events = {};
const tools = [];
const commands = [];
let widgets = 0; // the mock exposes this; the extension must never call it
const pi = {
  on(ev, h) { (events[ev] ??= []).push(h); },
  registerTool(t) { tools.push(t.name); },
  registerCommand(name) { commands.push(name); },
  setWidget() { widgets++; }, // must never fire — widget code is gone, grep-zero guarantees it
};
mod.default(pi);

const skill = await events.resources_discover?.[0]?.();
const skillPaths = skill?.skillPaths ?? [];

const expectTools = ["beads_ready","beads_list","beads_show","beads_deps","beads_create","beads_update","beads_close","beads_dep","beads_undep","beads_comment"];
const expectCommands = ["beads","beads-sync","beads-init","beads-mode"];

const failures = [];
if (JSON.stringify(tools) !== JSON.stringify(expectTools)) failures.push(`tools: got ${tools.join(",")}`);
if (JSON.stringify(commands) !== JSON.stringify(expectCommands)) failures.push(`commands: got ${commands.join(",")}`);
if (skillPaths.length !== 1) failures.push(`skills: got ${skillPaths.length} paths`);
if (widgets !== 0) failures.push(`widget: setWidget called ${widgets} time(s)`);

if (failures.length) { console.error("SMOKE FAIL:\n" + failures.join("\n")); process.exit(1); }
console.log(`SMOKE OK: ${tools.length} tools, ${commands.length} commands, ${skillPaths.length} skill, 0 widget refs`);
```

Run it:

```bash
node --experimental-strip-types /tmp/pi-beads-smoke.mjs
```
Expected: `SMOKE OK: 10 tools, 4 commands, 1 skill, 0 widget refs`, exit 0.

- [ ] **Step 4: Diff + status review**

```bash
git status --short
git diff --stat HEAD~3..HEAD
```
Expected: `git status` clean; the three commits above touch only the intended files (index.ts, package.json, deleted widget files, README.md, AGENTS.md).

- [ ] **Step 5: No commit** — this task is verification only. If the smoke or greps fail, fix in the relevant source file and re-run Steps 1–3 in the same task; do not proceed to a broken state.

---

## Verification (final checklist from the spec)

- [ ] `packages/pi-beads` loads as a pi extension with the widget gone: 10 tools, 4 commands, status-line segment, 1 bundled skill (smoke, Task 4 Step 3).
- [ ] Strictly zero widget references in `packages/pi-beads/src` + `package.json`; `README.md` + `AGENTS.md` free of leftover widget content (screenshots / legend / beads-wip / glyphs / make targets). The bare words "widget" and `✓` may appear only in the approved narrative and the `bd✓` status-line text.
- [ ] `npm test` no longer exists for pi-beads and nothing else references it.
- [ ] `git status` clean after the last commit; deletions are exactly the widget files.
