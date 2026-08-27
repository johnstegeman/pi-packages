import assert from "node:assert/strict";
import {
  widgetLines,
  displayWidth,
  formatAge,
  parseClosedWisps,
  titleOrdinal,
} from "./widget-lines.mjs";

const P = (n) => ({
  id: `p-${n}`,
  repo: "r",
  title: "t",
  priority: 2,
});

// ---------- nothing to draw ----------
assert.deepEqual(widgetLines({ entries: [] }, 80), []);
assert.deepEqual(widgetLines(undefined, 80), []);
assert.deepEqual(widgetLines({ entries: [P(1)] }, 0), []);
assert.deepEqual(widgetLines({ entries: [P(1)] }, -5), []);

// ---------- header with counters ----------
const head = widgetLines(
  {
    entries: [
      { id: "crmback-1a2", repo: "crm-backend", title: "a", priority: 1 },
      { id: "front-7x9", repo: "crm-front", title: "b", priority: 2 },
      {
        id: "chub-3k1",
        repo: "content-hub",
        title: "c",
        priority: 0,
        closed: true,
      },
    ],
    closedCount: 1,
    readyCount: 12,
  },
  120,
)[0];
assert.equal(head, "\u29BF beads \u00b7 2 active \u00b7 1 done \u00b7 12 ready", head);

// ready unknown -> the segment is gone (never "0 ready")
const noReady = widgetLines(
  { entries: [P(1)], closedCount: 0, readyCount: null },
  120,
)[0];
assert.ok(!noReady.includes("ready"), noReady);
assert.ok(!noReady.includes("done"), noReady);
assert.ok(
  widgetLines({ entries: [P(1)], readyCount: 0 }, 120)[0].includes("0 ready"),
);

// ---------- tree branches, glyphs, priority and age columns ----------
const tree = widgetLines(
  {
    entries: [
      {
        id: "crmback-1a2",
        repo: "crm-backend",
        title: "Fix invoice PDF export",
        priority: 1,
        age: "14m",
      },
      {
        id: "front-7x9",
        repo: "crm-front",
        title: "Header",
        priority: 2,
        age: "3h",
      },
      {
        id: "chub-3k1",
        repo: "content-hub",
        title: "Import",
        priority: 0,
        closed: true,
      },
    ],
    closedCount: 1,
    readyCount: 12,
  },
  100,
);
assert.equal(tree.length, 4); // header + 3 rows
assert.ok(
  tree[1].startsWith("\u251c\u2500 \u25d0 P1 crmback-1a2  [crm-backend] "),
  tree[1],
);
assert.ok(
  tree[2].startsWith("\u251c\u2500 \u25d0 P2 front-7x9    [crm-front]   "),
  tree[2],
);
assert.ok(
  tree[3].startsWith("\u2514\u2500 \u2713 P0 chub-3k1     [content-hub] "),
  tree[3],
);
// age is right-aligned in its own column, closed row has none
assert.ok(tree[1].endsWith("14m"), tree[1]);
assert.ok(tree[2].endsWith(" 3h"), tree[2]);
assert.ok(!/\d[mhd]$/.test(tree[3]), tree[3]);
for (const l of tree) assert.ok(displayWidth(l) <= 100, `too wide: ${l}`);

// ---------- truncation by DISPLAY width ----------
for (const filler of ["\u6f22", "\u{1F600}"]) {
  const cut = widgetLines(
    {
      entries: [
        {
          id: "p-1",
          repo: "r",
          title: filler.repeat(60),
          priority: 2,
          age: "9h",
        },
      ],
    },
    40,
  );
  for (const l of cut)
    assert.ok(displayWidth(l) <= 40, `width ${displayWidth(l)}: ${l}`);
  assert.ok(cut[1].includes("\u2026"), cut[1]); // the title really was cut
}
// CJK: a length-based cut would have overflowed (fewer code units than columns)
assert.ok(
  widgetLines(
    {
      entries: [
        { id: "p-1", repo: "r", title: "\u6f22".repeat(60), priority: 2 },
      ],
    },
    40,
  )[1].length < 40,
);

// ---------- row budget: done + active win, to-do is evicted first ----------
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

// ---------- formatAge ----------
const now = Date.parse("2026-08-23T12:00:00Z");
assert.equal(formatAge("2026-08-23T11:46:00Z", now), "14m");
assert.equal(formatAge("2026-08-23T09:00:00Z", now), "3h");
assert.equal(formatAge("2026-08-21T12:00:00Z", now), "2d");
assert.equal(formatAge(undefined, now), "");
assert.equal(formatAge("not a date", now), "");

// ---------- THE hard rule: colour never changes the visible width ----------
const ANSI = /\u001b\[[0-9;]*m/g;
const hasAnsi = (s) => /\u001b\[[0-9;]*m/.test(s); // separate, non-global: .test on /g is stateful
const theme = {
  fg: (_color, text) => `\u001b[38;5;42m${text}\u001b[39m`,
  strikethrough: (text) => `\u001b[9m${text}\u001b[29m`,
};
const state = {
  entries: [
    {
      id: "crmback-1a2",
      repo: "crm-backend",
      title: "\u{1F600}\u6f22".repeat(30),
      priority: 1,
      age: "14m",
    },
    {
      id: "front-7x9",
      repo: "crm-front",
      title: "b",
      priority: 2,
      age: "3h",
    },
    {
      id: "chub-3k1",
      repo: "content-hub",
      title: "c",
      priority: 0,
      closed: true,
    },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `x-${i}`,
      repo: "rr",
      title: "y",
      priority: 3,
    })),
    // ready/to-do rows (phase model)
    { id: "t-1", repo: "rr", title: "todo a", priority: 2, phase: "ready" },
    { id: "t-2", repo: "rr", title: "todo b", priority: 1, phase: "ready" },
  ],
  closedCount: 2,
  readyCount: 12,
};
for (const width of [10, 24, 37, 40, 80, 120]) {
  const plain = widgetLines(state, width);
  const painted = widgetLines(state, width, theme);
  assert.equal(painted.length, plain.length, `line count differs at ${width}`);
  for (let i = 0; i < plain.length; i++) {
    const stripped = painted[i].replace(ANSI, "");
    assert.equal(
      stripped,
      plain[i],
      `painted twin differs at width ${width}, line ${i}`,
    );
    assert.equal(
      displayWidth(stripped),
      displayWidth(plain[i]),
      `visible width differs at width ${width}, line ${i}`,
    );
    assert.ok(
      displayWidth(plain[i]) <= width,
      `line ${i} too wide at ${width}: ${plain[i]}`,
    );
  }
  assert.ok(painted.some(hasAnsi), `nothing painted at width ${width}`);
}

// ---------- phase model: active -> ready -> closed ----------
const board = widgetLines(
  {
    entries: [
      { id: "a-1", repo: "r", title: "current", priority: 1, phase: "active" },
      { id: "t-1", repo: "r", title: "todo one", priority: 2, phase: "ready" },
      { id: "t-2", repo: "r", title: "todo two", priority: 3, phase: "ready" },
      { id: "c-1", repo: "r", title: "done one", priority: 0, phase: "closed" },
    ],
    closedCount: 1,
    readyCount: 3,
  },
  100,
);

assert.equal(board.length, 5, board.join("\n")); // header + 4 rows
// header counts: active rows, ready rows, session-closed total
assert.ok(board[0].includes("1 active"), board[0]);
assert.ok(board[0].includes("3 ready"), board[0]);
assert.ok(board[0].includes("1 done"), board[0]);
// order is active, then ready, then closed; glyphs distinguish the phases
assert.ok(board[1].startsWith("\u251c\u2500 \u25d0 "), board[1]); // ◐ active
assert.ok(board[2].startsWith("\u251c\u2500 \u25e6 "), board[2]); // ◦ ready
assert.ok(board[3].startsWith("\u251c\u2500 \u25e6 "), board[3]); // ◦ ready
assert.ok(board[4].startsWith("\u2514\u2500 \u2713 "), board[4]); // ✓ closed
// titles ride along on every phase, not just the id
assert.ok(board[1].includes("current"), board[1]);
assert.ok(board[2].includes("todo one"), board[2]);
assert.ok(board[3].includes("todo two"), board[3]);
assert.ok(board[4].includes("done one"), board[4]);
for (const l of board) assert.ok(displayWidth(l) <= 100, `too wide: ${l}`);

// widgetState only ever sends an age for active rows — so a ready row carrying
// an empty age must not reserve an age column at all (mirrors index.ts)
const noAge = widgetLines(
  {
    entries: [
      { id: "t-1", repo: "r", title: "todo", priority: 2, phase: "ready", age: "" },
      { id: "a-1", repo: "r", title: "current", priority: 2, phase: "active", age: "9h" },
    ],
    readyCount: 1,
  },
  100,
);
assert.ok(noAge[1].endsWith("9h"), noAge[1]); // active keeps its age column
assert.ok(!noAge[2].includes("9h"), noAge[2]); // ready does not

// done rows win the budget alongside active; to-do fills the rest
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
assert.ok(!overflow.slice(1, 11).some((l) => l.startsWith("\u2514"))); // under a tail, no row uses the closing branch

// legacy `closed: true` shape still renders as the closed phase
const legacy = widgetLines(
  {
    entries: [
      { id: "c-1", repo: "r", title: "legacy done", priority: 0, closed: true },
    ],
    closedCount: 1,
  },
  80,
);
assert.ok(legacy[1].includes("\u2713") && legacy[1].includes("legacy done"), legacy[1]);

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


console.log("widget-lines: ok");


// ---------- titleOrdinal: "Task N" leading ordinals, numeric not lexicographic ----------
assert.equal(titleOrdinal("Task 1: Scan-scope exclusions"), 1);
assert.equal(titleOrdinal("Task 10: Extractor prompt updates"), 10);
assert.equal(titleOrdinal("Task 13: Bootstrap-vs-delta design note"), 13);
assert.equal(titleOrdinal("  task 2: leading whitespace + lower case"), 2);
// titles that are not task-numbered carry no ordinal
assert.equal(titleOrdinal("Phase 3 follow-on: implement bootstrap-vs-delta"), null);
assert.equal(titleOrdinal("Brainstorm: write design doc"), null);
assert.equal(titleOrdinal("Refactor the scheduler"), null);
// a decimal sequence is not an integer task number
assert.equal(titleOrdinal("Task 3.5: refine diff path"), null);
assert.equal(titleOrdinal(undefined), null);
assert.equal(titleOrdinal(""), null);

// ready rows: numbered tasks ascend numerically (10 after 3), unnumbered trail by incoming order
const ord = widgetLines(
  {
    entries: [
      // incoming (bd) order is deliberately scrambled vs the task numbers
      { id: "t-13", repo: "r", title: "Task 13: last", priority: 2, phase: "ready" },
      { id: "t-2", repo: "r", title: "Task 2: second", priority: 2, phase: "ready" },
      { id: "t-10", repo: "r", title: "Task 10: third", priority: 2, phase: "ready" },
      { id: "t-3", repo: "r", title: "Task 3: third", priority: 2, phase: "ready" },
      { id: "t-misc-1", repo: "r", title: "Phase 3 follow-on: x", priority: 2, phase: "ready" },
      { id: "t-misc-2", repo: "r", title: "Brainstorm: y", priority: 2, phase: "ready" },
    ],
    readyCount: 6,
  },
  120,
);
assert.deepEqual(
  ord.slice(1).map((l) => l.match(/t-[a-z0-9-]+/)[0]),
  ["t-2", "t-3", "t-10", "t-13", "t-misc-1", "t-misc-2"],
  ord.join("\n"),
);

// under a tight budget the tail (highest task numbers + unnumbered) is evicted, not Task 1..N
const tight = widgetLines(
  {
    entries: [
      { id: "a-1", repo: "r", title: "current", priority: 2, phase: "active" },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `ready-${i + 1}`,
        repo: "r",
        title: `Task ${i + 1}: work`,
        priority: 2,
        phase: "ready",
      })),
      { id: "misc", repo: "r", title: "Brainstorm: y", priority: 2, phase: "ready" },
      { id: "c-1", repo: "r", title: "done one", priority: 2, phase: "closed" },
    ],
    closedCount: 1,
    readyCount: 10,
  },
  120,
);
// 10-row budget: active + closed = 2 slots, so 8 of the 10 ready rows show, 2 are evicted
const idsTight = tight.slice(1).join("\n");
for (const id of ["a-1", "ready-1", "ready-8", "c-1"])
  assert.ok(idsTight.includes(id), `missing ${id}:\n${idsTight}`);
assert.ok(!idsTight.includes("ready-9"), `latest task should be evicted:\n${idsTight}`);
assert.ok(!idsTight.includes("misc"), `unnumbered should be evicted first:\n${idsTight}`);
assert.ok(tight.join("\n").includes("+2 more"), tight.join("\n"));