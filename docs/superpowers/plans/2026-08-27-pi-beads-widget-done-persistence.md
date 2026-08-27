# pi-beads Widget Done-Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pi-beads widget's `✓` done rows DB-derived and persistent — they appear for the whole phase as closed wisps accumulate, and empty the turn after superpowers purges them with `bd mol wisp gc --closed --force`.

**Architecture:** The widget's done list stops being an in-memory, one-agent-turn accumulator (`closedShown`) and becomes a read of the database's closed wisps (`bd mol wisp list --all --json`), refreshed at session start, after every `beads_*` write, and unconditionally on every `agent_start`. Because superpowers mutates beads with bare `bd` calls never seen by the `beads_*` tools, the turn-boundary re-read is the only way the widget can observe mid-phase closes and the phase-end purge. The row budget rises from 6 to 10 and to-do rows are evicted before done rows so the accumulating checklist stays on screen.

**Tech Stack:** TypeScript extension (`pi.registerProvider`/`pi.on`), plain-JS pure renderer module (`widget-lines.mjs`) tested with `node --test`, `bd mol wisp list --all --json` (verified on bd 1.2.2).

## Global Constraints

- Widget row budget lifts from 6 to 10 (`MAX_ROWS` in `widget-lines.mjs`).
- Display order stays `active → to-do → done`; done rows render in the order the DB list returns them (creation order).
- Done rows are wisp-scoped: only `bd mol wisp list --all --json` entries with `status === "closed"` count.
- The done list and the `N done` header come ONLY from the DB read — there is no closed accumulator in memory.
- `agent_start` re-reads unconditionally every turn (no early return) and never blocks the turn (fire-and-forget).
- Do not add any timer/polling or disk persistence; the widget stays session-memory except for the existing `bd` reads.
- Do not change the `beads_*` tool surface, the id-prefix routing, or any tool parameters.
- Non-wisp tasks closed mid-phase do not appear as `✓` rows (intentional, matches the `bd mol wisp gc` purge semantics).
- Tests: `cd packages/pi-beads && npm test` (runs `node --test src/widget-lines.test.mjs`). Extension syntax: `node --experimental-strip-types --check src/index.ts`.

---

### Task 1: `parseClosedWisps` pure parser

**Files:**
- Modify: `packages/pi-beads/src/widget-lines.mjs` — add an exported `parseClosedWisps` near the other pure helpers (after `formatAge`, before `themeOf`)
- Test: `packages/pi-beads/src/widget-lines.test.mjs`

**Interfaces:**
- Consumes: no earlier tasks.
- Produces: `export function parseClosedWisps(json: string | object | null, repo?: string): { id: string; repo?: string; title: string; priority?: number }[]` — parses `bd mol wisp list --all --json` (the real wrapper `{ count, schema_version, wisps: [...] }`, a bare array, or a leading tip line before the JSON object) and returns only entries with `status === "closed"` and a non-empty `id`.

- [ ] **Step 1: Write the failing tests**

Append to `src/widget-lines.test.mjs`, just before the final `console.log("widget-lines: ok");`:

```js
// ---------- parseClosedWisps (bd mol wisp list --all --json -> done rows) ----------
const closedWispList = JSON.stringify({
  count: 2,
  schema_version: 1,
  wisps: [
    { id: "beads-wisp-a", title: "Explore", status: "closed", priority: 2, type: "task" },
    { id: "beads-wisp-b", title: "Design", status: "in_progress", priority: 1, type: "task" },
    { id: "beads-wisp-c", title: "Wrap up", status: "closed", priority: 0, type: "task" },
  ],
});
assert.deepEqual(parseClosedWisps(closedWispList, "repo-x"), [
  { id: "beads-wisp-a", repo: "repo-x", title: "Explore", priority: 2 },
  { id: "beads-wisp-c", repo: "repo-x", title: "Wrap up", priority: 0 },
]);

// a bare array shape also parses
assert.deepEqual(
  parseClosedWisps(JSON.stringify([{ id: "w-1", status: "closed", title: "t" }]), "r"),
  [{ id: "w-1", repo: "r", title: "t", priority: undefined }],
);

// a leading tip line before the JSON object is stripped
assert.equal(parseClosedWisps("\u{1F4A1} Tip: version info\n" + closedWispList, "r").length, 2);

// empty / malformed inputs decay to []
assert.deepEqual(parseClosedWisps("", "r"), []);
assert.deepEqual(parseClosedWisps("not json", "r"), []);
assert.deepEqual(parseClosedWisps(null, "r"), []);
assert.deepEqual(parseClosedWisps(JSON.stringify({ wisps: [] }), "r"), []);

// closed entries without an id are dropped
assert.deepEqual(
  parseClosedWisps(JSON.stringify({ wisps: [{ status: "closed", title: "no id" }] }), "r"),
  [],
);
```

- [ ] **Step 2: Run it to verify it fails**

`cd packages/pi-beads && npm test`

Expected: FAIL — `parseClosedWisps` is not exported (a `TypeError`/undefined reference before the assertions).

- [ ] **Step 3: Implement the minimal parser**

In `src/widget-lines.mjs`, add (after the `formatAge` function, before `const PLAIN`):

```js
/**
 * Parse `bd mol wisp list --all --json` into the widget's "done" rows.
 * Keeps only wisps with `status === "closed"`. Accepts the real wrapper shape
 * ({ count, schema_version, wisps: [...] }), a bare array, and a leading tip
 * line before the JSON object. Returns [] on any malformed input.
 */
export function parseClosedWisps(json, repo = "") {
  let obj;
  try {
    const text = typeof json === "string" ? json.trim().replace(/^[^{[]*/, "") : json;
    obj = text ? JSON.parse(text) : null;
  } catch {
    return [];
  }
  const wisps = Array.isArray(obj) ? obj : obj?.wisps ?? [];
  const out = [];
  for (const w of wisps) {
    if (!w || w.status !== "closed" || !w.id) continue;
    out.push({
      id: String(w.id),
      repo,
      title: w.title ? String(w.title) : "",
      priority: Number.isFinite(w.priority) ? Number(w.priority) : undefined,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

`cd packages/pi-beads && npm test`

Expected: PASS (`widget-lines: ok`, 1 test file green).

- [ ] **Step 5: Commit**

```bash
git add packages/pi-beads/src/widget-lines.mjs packages/pi-beads/src/widget-lines.test.mjs
git commit -m "feat(pi-beads): parseClosedWisps helper for the DB-derived done list"
```

---

### Task 2: Renderer budget — `MAX_ROWS` 10, to-do evicted before done

**Files:**
- Modify: `packages/pi-beads/src/widget-lines.mjs` — `MAX_ROWS`, and the ordering/eviction block inside `widgetLines`
- Test: `packages/pi-beads/src/widget-lines.test.mjs`

**Interfaces:**
- Consumes: Task 1's `parseClosedWisps` is not needed here. Uses the existing `phaseOf(e)`.
- Produces: keeps `widgetLines(state, width, theme)` signature unchanged. New eviction semantics: done + active win the row budget; to-do is evicted first.

- [ ] **Step 1: Update the existing cap tests and add a protection test**

Replace the existing `many` block (5 active + 3 legacy `closed: true`) with expectations for the raised budget:

```js
const many = {
  entries: [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `a-${i}`,
      repo: "r",
      title: "t",
      priority: 2,
    })),
    { id: "c-1", repo: "r", title: "closed one", priority: 2, closed: true },
    { id: "c-2", repo: "r", title: "closed two", priority: 2, closed: true },
    { id: "c-3", repo: "r", title: "closed three", priority: 2, closed: true },
  ],
  closedCount: 3,
};
const allShown = widgetLines(many, 80);
assert.equal(allShown.length, 9); // header + 8 rows, all within the 10-row budget
assert.ok(allShown.join("\n").includes("c-3")); // nothing is evicted any more
for (const l of widgetLines(many, 6))
  assert.ok(displayWidth(l) <= 6, `too wide: ${l}`);
```

Replace the existing `crowded` block (4 `phase: "ready"` + 3 closed) so it now expects all rows shown (nothing evicted at 7 rows within the 10-row budget):

```js
const crowded = widgetLines(
  {
    entries: [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `t-${i}`,
        repo: "r",
        title: "todo",
        priority: 2,
        phase: "ready",
      })),
      { id: "c-1", repo: "r", title: "done one", priority: 2, phase: "closed" },
      { id: "c-2", repo: "r", title: "done two", priority: 2, phase: "closed" },
      { id: "c-3", repo: "r", title: "done three", priority: 2, phase: "closed" },
    ],
    closedCount: 3,
    readyCount: 4,
  },
  80,
);
assert.equal(crowded.length, 8, crowded.join("\n")); // header + 7 rows (4 to-do + 3 done)
assert.ok(!crowded.join("\n").includes("+1 more"), crowded.join("\n")); // nothing evicted
assert.ok(crowded.join("\n").includes("c-3"), crowded.join("\n")); // all done rows survive
```

Add a new block that proves to-do is evicted *before* done once the budget overflows (11 rows total):

```js
// with more rows than the 10-row budget, to-do is evicted first; done survives
const overflow = widgetLines(
  {
    entries: [
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `t-${i}`,
        repo: "r",
        title: "todo",
        priority: 2,
        phase: "ready",
      })),
      { id: "c-1", repo: "r", title: "done one", priority: 2, phase: "closed" },
      { id: "c-2", repo: "r", title: "done two", priority: 2, phase: "closed" },
      { id: "c-3", repo: "r", title: "done three", priority: 2, phase: "closed" },
    ],
    closedCount: 3,
    readyCount: 8,
  },
  80,
);
assert.equal(overflow.length, 12, overflow.join("\n")); // header + 10 rows + "+1 more"
assert.equal(overflow[11], "+1 more");
assert.ok(overflow.join("\n").includes("c-1") && overflow.join("\n").includes("c-3"));
assert.ok(overflow[10].includes("c-3"), overflow[10]); // last shown row is the last done row
```

- [ ] **Step 2: Run tests to verify they fail**

`cd packages/pi-beads && npm test`

Expected: FAIL — the old `MAX_ROWS`/eviction produces different line counts and the `overflow` assertions fail.

- [ ] **Step 3: Implement the new budget and eviction**

In `src/widget-lines.mjs`:
1. Change `const MAX_ROWS = 6;` to `const MAX_ROWS = 10;`.
2. Replace the ordering/eviction block inside `widgetLines`:

```js
  // ordering: active, then to-do, then done. Done and active win the budget;
  // to-do is evicted first so the accumulating done list stays on screen.
  const active = all.filter((e) => phaseOf(e) === "active");
  const todo = all.filter((e) => phaseOf(e) === "ready");
  const closed = all.filter((e) => phaseOf(e) === "closed");
  const budget = MAX_ROWS - active.length - closed.length;
  const keptTodo = budget > 0 ? todo.slice(0, budget) : [];
  const shown = [...active, ...keptTodo, ...closed];
  const hidden = todo.length - keptTodo.length;
```

(The header and row-drawing code below the block are unchanged; they already consume `shown`/`hidden`, and the age-aware `reserve`/`gap` logic already leaves `age` empty for closed rows.)

- [ ] **Step 4: Run tests to verify they pass**

`cd packages/pi-beads && npm test`

Expected: PASS, including the existing hard-rule loop (painted twin == plain twin, width respected, for widths 10/24/37/40/80/120) and the `board`/`noAge`/`tree` phase tests.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-beads/src/widget-lines.mjs packages/pi-beads/src/widget-lines.test.mjs
git commit -m "feat(pi-beads): widget budget 6->10, to-do evicted before done"
```

---

### Task 3: `index.ts` — DB-derived done list with turn-end refresh

**Files:**
- Modify: `packages/pi-beads/src/index.ts`:
  - import line 33 (add `parseClosedWisps` to the `widget-lines.mjs` import)
  - widget state block (the `closedShown` map + `closedCount` accumulator)
  - `widgetState()` entries + `closedCount`
  - `renderWip()` empty-check
  - new `refreshDone()` (place directly after `refreshReady()`)
  - `afterWrite()`, `session_start` (both branches), `agent_start` handler
  - `beads_close` (rename local `done` → `closedIds`; delete the `closedShown`/meta enrichment block)

**Interfaces:**
- Consumes: Task 1's `parseClosedWisps(json, repo)`.
- Produces: module state `done: Map<string, WipEntry>`; `refreshDone(): Promise<void>` that reads `bd mol wisp list --all --json` per repo (single-repo = one read; umbrella = union over the umbrella plus every repo dir in `prefixToDir`) and repopulates `done`; header count `done.size`.

- [ ] **Step 1: Import + state declaration**

Change the import (line 33):

```ts
import { widgetLines, formatAge, parseClosedWisps } from "./widget-lines.mjs";
```

Replace the state block:

```ts
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

- [ ] **Step 2: `widgetState()` and `renderWip()`**

In `widgetState()`, change the entries and counter:

```ts
    return {
      entries: [
        ...Array.from(wip, ([id, v]) => row(id, v, "active")),
        ...Array.from(todo, ([id, v]) => row(id, v, "ready")),
        ...Array.from(done, ([id, v]) => row(id, v, "closed")),
      ],
      closedCount: done.size,
      readyCount,
    };
```

In `renderWip()`, change the empty-check:

```ts
      if (wip.size === 0 && todo.size === 0 && done.size === 0) {
```

- [ ] **Step 3: Add `refreshDone()` right after `refreshReady()`**

```ts
  async function refreshDone(): Promise<void> {
    // closed wisps currently in the DB = the widget's done list. Wisps are
    // per-repo-local (not in the umbrella aggregate), so in umbrella mode read
    // each known repo and union; single-repo is one read. Failure (missing/old
    // bd, unknown subcommand) is silent — the done list just stays as-is.
    const dirs = isUmbrella
      ? Array.from(new Set([...prefixToDir.values(), umbrella]))
      : [umbrella];
    const next = new Map<string, WipEntry>();
    for (const dir of dirs) {
      const r = await bd(["mol", "wisp", "list", "--all", "--json"], dir);
      if (!r.ok) continue;
      for (const e of parseClosedWisps(r.out, path.basename(dir))) {
        next.set(e.id, e);
      }
    }
    done.clear();
    for (const [id, e] of next) done.set(id, e);
  }
```

- [ ] **Step 4: Wire the refresh points**

`afterWrite()` — refresh both lists, render when both settle:

```ts
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

`session_start` — seed all three lists; and the un-initialized branch:

```ts
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
```

`agent_start` — replace the one-turn clear with the unconditional turn-end re-read:

```ts
  pi.on("agent_start", async () => {
    // Re-read the closed-wisp list every turn, unconditionally: superpowers
    // mutates the DB with bare `bd` calls (closes mid-phase, and ends the phase
    // with `bd mol wisp gc --closed --force`) that never reach the beads_*
    // tools. Fire-and-forget so this never blocks the turn.
    void refreshDone().then(() => renderWip());
  });
```

- [ ] **Step 5: Simplify `beads_close`**

Rename the local success list and drop the `closedShown`/meta-enrichment block so the DB read (already triggered by `afterWrite` inside this handler) is the only source for done rows:

```ts
      const closedIds: string[] = [];
```

and in the same handler, `done.push(...rids)` → `closedIds.push(...rids)`; then replace the close-tracking loop and return:

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

Do NOT delete `metaOf` — it is still used by the `beads_update` in-progress path.

- [ ] **Step 6: Syntax check + no regression**

```bash
cd packages/pi-beads
node --experimental-strip-types --check src/index.ts
npm test
```

Expected: syntax OK; `widget-lines: ok` green (the parser/budget tests from Tasks 1–2 still pass).

- [ ] **Step 7: Manual smoke against a live DB** (only if one is available; otherwise skip — this is optional)

Render the widget state the way the extension builds it, e.g.:

```bash
cd "$(git -C /Users/jstegeman/orca/workspaces/pi-packages/beads-debug rev-parse --show-toplevel)/packages/pi-beads"
node --experimental-strip-types -e '
import { parseClosedWisps, widgetLines } from "./src/widget-lines.mjs";
import { execFileSync } from "node:child_process";
const out = execFileSync("bd", ["mol", "wisp", "list", "--all", "--json"], { encoding: "utf8", cwd: "/Users/jstegeman/Projects/_ai/pi-superpowers-plus" });
const done = parseClosedWisps(out, "pi-superpowers-plus");
console.log(widgetLines({ entries: [...done.map((e) => ({ ...e, phase: "closed" }))], closedCount: done.length, readyCount: null }, 79).map((l) => " " + l).join("\n"));
'
```

Then run `bd mol wisp gc --closed --force` in that repo and re-run the read — the done list must come back empty.

- [ ] **Step 8: Commit**

```bash
git add packages/pi-beads/src/index.ts
git commit -m "feat(pi-beads): DB-derived done rows, turn-end widget refresh"
```

---

### Task 4: Documentation (README + SPEC-ui.md)

**Files:**
- Modify: `packages/pi-beads/README.md`
- Modify: `packages/pi-beads/SPEC-ui.md`

**Interfaces:**
- Consumes: behavior from Task 3. Produces documentation only.

- [ ] **Step 1: README — legend item 2 (counters)**

Replace:

```markdown
2. The header counters: issues in progress this session, issues closed this session, and
   how many are ready to work — open and unblocked, wisps included. When the ready
   number is unknown the segment disappears entirely: a `0` is never shown.
```

with:

```markdown
2. The header counters: issues in progress, how many are ready to work — open and
   unblocked, wisps included — and the currently-closed wisps (`N done`, which empties
   once the phase's wisps are purged). When the ready number is unknown the segment
   disappears entirely: a `0` is never shown.
```

- [ ] **Step 2: README — legend item 3 (done rows persist)**

Replace:

```markdown
3. `◐` is in progress, `○` is open/to-do, `✓` is closed. To-do rows come from the same
   `bd ready` view as `beads_ready` (so brainstormed wisps appear here too). A closed
   row survives one agent turn and then leaves; the header counter stays until the
   session ends.
```

with:

```markdown
3. `◐` is in progress, `○` is open/to-do, `✓` is closed. To-do rows come from the same
   `bd ready` view as `beads_ready` (so brainstormed wisps appear here too). Closed
   (`✓`) wisps persist for the phase: they are re-read from the database every turn
   and only disappear when purged — e.g. superpowers ends a phase with
   `bd mol wisp gc --closed --force`.
```

- [ ] **Step 3: README — row budget paragraph**

Replace:

```markdown
At most six rows are drawn; the rest collapse into a `+N` tail, and closed rows are
evicted first. In a narrow pane the titles are cut with an ellipsis and the repository
column disappears:
```

with:

```markdown
At most ten rows are drawn; when they overflow, to-do rows are evicted first (the
accumulating done list is kept) and the rest collapse into a `+N` tail. In a narrow pane
the titles are cut with an ellipsis and the repository column disappears:
```

- [ ] **Step 4: README — Limitations paragraph**

Replace:

```markdown
Widget state is session memory. Changes made in another window, or straight through `bd`,
appear only after the next read. A closed row survives one agent turn; the closed counter
survives until the session ends. At most six rows are drawn, the rest collapse into a
`+N` tail.
```

with:

```markdown
Widget state is session memory, but the done rows are read back from the database on
every turn, so changes made in another window or straight through `bd` (including a
phase-end `bd mol wisp gc --closed --force`) appear within a turn. At most ten rows are
drawn; to-do rows are evicted before done rows, and the rest collapse into a `+N` tail.
```

- [ ] **Step 5: SPEC-ui.md — append a superseding note to the existing addendum**

Append at the end of `SPEC-ui.md`:

```markdown

---

# Addendum update (2026-08-27) — DB-derived done rows

The widget's done rows are no longer a one-turn, in-memory list: they are read from
`bd mol wisp list --all --json` (closed wisps) on every `agent_start`, at session
start, and after each `beads_*` write, and persist for the phase. Superpowers (or any
bare `bd` caller) clears them by purging closed wisps (`bd mol wisp gc --closed
--force`); the widget notices on the next turn. The row budget rose from 6 to 10 and
to-do rows are evicted before done rows. `beads_close` no longer keeps a `closedShown`
map. See `docs/superpowers/specs/2026-08-27-pi-beads-widget-done-persistence-design.md`.
```

- [ ] **Step 6: Verify docs read clean**

```bash
grep -n "mol wisp" packages/pi-beads/README.md     # new persist/purge wording present
grep -n "survives one agent turn" packages/pi-beads/README.md || true  # old wording gone (no output expected)
```

- [ ] **Step 7: Commit**

```bash
git add packages/pi-beads/README.md packages/pi-beads/SPEC-ui.md
git commit -m "docs(pi-beads): widget done rows persist until wisps are purged"
```

---

## Verification

- [ ] `cd packages/pi-beads && npm test` → green (`widget-lines: ok`).
- [ ] `node --experimental-strip-types --check packages/pi-beads/src/index.ts` → OK.
- [ ] Manual smoke (optional, needs a beads DB): a closed wisp appears as a `✓` row the same turn it is closed; running `bd mol wisp gc --closed --force` clears the done section (and `N done`) on the next turn's re-read.
- [ ] README widget legend and Limitations describe persisted, DB-derived done rows with the 10-row budget and to-do-first eviction.

## Summary

Tasks 1–2 make the renderer and its tests ready for a persistent, DB-derived done list (a testable parser, and a 10-row budget that protects done rows from eviction). Task 3 rewires the extension state and refresh cadence so the widget's done rows come from the database and are refreshed every turn — the mechanism that observes superpowers' bare-`bd` closes and the phase-end purge without any event or cross-package coupling. Task 4 aligns the docs. The result: `✓` rows accumulate for the whole phase and empty when the phase's wisps are purged, which is exactly the "persist until the phase is over" behavior.
