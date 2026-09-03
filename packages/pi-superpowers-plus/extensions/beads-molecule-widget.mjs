/**
 * Pure parsing + rendering for the superpowers molecule widget.
 * Plain JS (no TS) so it's directly runnable/testable by node.
 */

// ---- minimal display-width + truncation + paint-after-cut helpers ----
// (self-contained here rather than depending on another package's internals;
// the width-safety rule is: measure the plain-text twin, only paint fragments
// after they've already been cut to width.)
function charWidth(cp) {
  if (cp === 0x200d) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff)
  )
    return 2;
  return 1;
}
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
  return w;
}
export function truncToWidth(s, width) {
  s = String(s);
  if (width <= 0) return "";
  if (displayWidth(s) <= width) return s;
  const budget = width - 1;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return `${out}\u2026`;
}
function assemble(frags, width) {
  let used = 0;
  let text = "";
  for (const f of frags) {
    if (!f.text) continue;
    if (used >= width) break;
    const piece = truncToWidth(f.text, width - used);
    if (!piece) break;
    text += f.paint ? f.paint(piece) : piece;
    used += displayWidth(piece);
  }
  return { text, width: used };
}

// ---- status markers (bd-list / R7 shape) ----
// open ○ · in_progress ◐ · blocked ● · closed ✓ · deferred ❄ · anything else ○
const STATUS_MARKER = {
  open: "\u25cb",
  in_progress: "\u25d0",
  blocked: "\u25cf",
  closed: "\u2713",
  deferred: "\u2744",
};
function markerFor(status) {
  return STATUS_MARKER[status] ?? "\u25cb";
}

/** Parse `bd mol current --json` output. Returns null on any malformed input. */
export function parseMoleculeCurrent(json) {
  let arr;
  try {
    const text = typeof json === "string" ? json.trim() : json;
    arr = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  const obj = Array.isArray(arr) ? arr[0] : arr;
  if (!obj?.molecule_id || !Array.isArray(obj.steps)) return null;
  const steps = obj.steps
    .filter((s) => s && s.issue && s.issue.id != null)
    .map((s) => ({
      id: s.issue.id,
      title: s.issue.title ?? "",
      priority: s.issue.priority,
      issue_type: s.issue.issue_type ?? "task",
      status: s.issue.status ?? "open",
      created_at: s.issue.created_at ?? "",
      step_status: s.status ?? "pending",
      is_current: !!s.is_current,
    }));
  const doneCount = steps.filter((s) => s.step_status === "done").length;
  return {
    molecule_id: obj.molecule_id,
    molecule_title: obj.molecule_title ?? "",
    current_step: obj.current_step ?? null,
    next_step: obj.next_step ?? null,
    steps,
    doneCount,
    total: obj.steps.length,
  };
}

const EXPLORE_PREFIX = "Explore project context: ";

// ---- topic + phase helpers (superpowers-workflow formula coupling) ----
// The widget and the formula ship in the same package; these key off the
// formula's step titles (spec 2026-09-03-superpowers-widget-phase-views-design.md).
export function topicFor(state) {
  if (!state || !Array.isArray(state.steps)) return "";
  const explore = state.steps.find((s) => s.title?.startsWith(EXPLORE_PREFIX));
  if (explore) {
    const t = explore.title.slice(EXPLORE_PREFIX.length).trim();
    if (t) return t;
  }
  return state.molecule_title ?? "";
}

export function phaseFor(state) {
  if (!state || !Array.isArray(state.steps)) return "brainstorming";
  const impl = state.steps.find((s) => /^Implement( |$)/.test(s.title ?? ""));
  if (!impl) return "brainstorming";
  if (impl.step_status === "done") return "finishing";
  if (impl.step_status === "ready" || impl.step_status === "current") return "implementing";
  return "brainstorming";
}

/**
 * Leading-edge + single-trailing-timer coalescer for a burst of change events.
 * First trigger() in an idle period fires immediately. Further trigger()s while
 * a window is open just mark "dirty"; when the window elapses, one more fire
 * happens if dirty, and a new window starts — otherwise the timer clears and
 * the next trigger() is a fresh leading edge. Caps fires to at most one per
 * windowMs during a sustained burst without ever delaying the first one.
 */
export function createChangeCoalescer(onFire, windowMs = 10000, timers = { setTimeout, clearTimeout }) {
  let timer = null;
  let dirty = false;
  function scheduleTick() {
    timer = timers.setTimeout(() => {
      if (dirty) {
        dirty = false;
        onFire();
        scheduleTick();
      } else {
        timers.clearTimeout(timer);
        timer = null;
      }
    }, windowMs);
  }
  return {
    trigger() {
      if (timer === null) {
        onFire();
        scheduleTick();
      } else {
        dirty = true;
      }
    },
  };
}

const PLAIN_FG = (_c, t) => t;
function themeOf(theme) {
  return theme && typeof theme.fg === "function" ? (c, t) => theme.fg(c, t) : PLAIN_FG;
}

// ---- phase views (canonical formula-step titles) ----
const BRAINSTORM_VIEW = [
  { label: "Explore project context", test: (t) => t.startsWith(EXPLORE_PREFIX) },
  { label: "Ask clarifying questions", test: (t) => t === "Ask clarifying questions" },
  { label: "Propose approaches", test: (t) => t === "Propose approaches" },
  { label: "Present design sections", test: (t) => t === "Present design sections" },
  { label: "User approves design", test: (t) => t === "User approves design" },
  { label: "Write spec to docs/superpowers/specs/", test: (t) => t.startsWith("Write spec") },
  { label: "Spec self-review", test: (t) => t === "Spec self-review" },
  { label: "User reviews written spec", test: (t) => t === "User reviews written spec" },
];

const FINISH_VIEW = [
  { label: "Verify", test: (t) => t === "Verify" },
  { label: "Smoke test / manual QA sign-off", test: (t) => t === "Smoke test / manual QA sign-off" },
  { label: "Finish development branch", test: (t) => t === "Finish development branch" },
];

const PHASE_LABEL = {
  brainstorming: "Brainstorming",
  implementing: "Implementing",
  finishing: "Finishing",
};

const MAX_LINES = 15;

/** Resolve the canonical view rows against the molecule's steps (missing -> null). */
function resolveRows(steps, view) {
  return view
    .map((v) => {
      const s = steps.find((x) => v.test(x.title));
      if (!s) return null;
      return { label: v.label, step: s };
    })
    .filter(Boolean);
}

/** Keep ≤ justUnder slots, closed rows last; tail `+N more` counts the overflow. */
function fitRows(rows) {
  const noTailSlots = MAX_LINES - 1; // content rows without a tail line
  if (rows.length <= noTailSlots) return { kept: rows, more: 0 };
  // Over flow: reserve the last line for "+N more", so only MAX_LINES-2 fit.
  const budget = MAX_LINES - 2;
  const pinned = rows.filter((r) => r.pinned);
  const others = rows.filter((r) => !r.pinned);
  const open = others.filter((r) => !r.closed);
  const closed = others.filter((r) => r.closed);
  const avail = Math.max(0, budget - pinned.length);
  const kept = [...pinned];
  if (open.length <= avail) {
    kept.push(...open);
    const rem = avail - open.length;
    kept.push(...closed.slice(0, rem));
  } else {
    kept.push(...open.slice(0, avail));
  }
  return { kept, more: rows.length - kept.length };
}

/** Render the molecule widget: header + one phase-specific view. Returns [] when there's nothing to draw. */
export function moleculeWidgetLines(state, width, theme) {
  const fg = themeOf(theme);
  if (!state || !Array.isArray(state.steps) || state.steps.length === 0 || !(width > 0)) return [];

  const topic = topicFor(state);
  const phase = phaseFor(state);
  const allDone = state.steps.every((s) => s.step_status === "done");

  if (allDone) {
    return [
      assemble(
        [
          { text: "\u2713 Superpowers: ", paint: (t) => fg("accent", t) },
          { text: `${topic} \u2014 finished`, paint: (t) => fg("text", t) },
        ],
        width,
      ).text,
    ];
  }

  const header = assemble(
    [
      { text: "Superpowers:", paint: (t) => fg("accent", t) },
      { text: ` ${topic}`, paint: (t) => fg("text", t) },
      { text: ` \u00b7 ${PHASE_LABEL[phase]}`, paint: (t) => fg("muted", t) },
      { text: ` \u00b7 ${state.doneCount}/${state.total}`, paint: (t) => fg("muted", t) },
    ],
    width,
  ).text;

  const rows = [];

  // A gate as the current step is always shown, pinned, as the waiting line.
  if (state.current_step && state.current_step.issue_type === "gate") {
    rows.push({
      text: assemble(
        [
          { text: "\u23f8 Waiting on you: ", paint: (t) => fg("warning", t) },
          { text: state.current_step.title ?? "", paint: (t) => fg("text", t) },
        ],
        width,
      ).text,
      closed: false,
      pinned: true,
    });
  }

  const stepRow = (step, label) => ({
    text: assemble(
      [
        { text: `${markerFor(step.status)} `, paint: (t) => fg(step.status === "closed" ? "text" : "warning", t) },
        { text: label ?? step.title ?? "", paint: (t) => fg(step.status === "closed" ? "muted" : "text", t) },
      ],
      width,
    ).text,
    closed: step.status === "closed",
    pinned: !!step.is_current,
  });

  if (phase === "brainstorming") {
    for (const s of resolveRows(state.steps, BRAINSTORM_VIEW)) rows.push(stepRow(s.step, s.label));
  } else if (phase === "implementing") {
    const impl = state.steps.find((s) => /^Implement( |$)/.test(s.title ?? ""));
    if (impl) rows.push(stepRow(impl));
    const kids = state.steps
      .filter((s) => impl && s.id.startsWith(`${impl.id}.`))
      .sort((a, b) =>
        (a.created_at ?? "") < (b.created_at ?? "")
          ? -1
          : (a.created_at ?? "") > (b.created_at ?? "")
            ? 1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
      );
    kids.forEach((kid, i) => {
      const last = i === kids.length - 1;
      rows.push({
        text: assemble(
          [
            { text: last ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ", paint: (t) => fg("muted", t) },
            { text: `${markerFor(kid.status)} `, paint: (t) => fg(kid.status === "closed" ? "text" : "warning", t) },
            { text: kid.title ?? "", paint: (t) => fg(kid.status === "closed" ? "muted" : "text", t) },
          ],
          width,
        ).text,
        closed: kid.status === "closed",
        pinned: !!kid.is_current,
      });
    });
  } else if (phase === "finishing") {
    for (const s of resolveRows(state.steps, FINISH_VIEW)) rows.push(stepRow(s.step, s.label));
  }

  const { kept, more } = fitRows(rows);
  const lines = [header, ...kept.map((r) => r.text)];
  if (more > 0) lines.push(fg("muted", truncToWidth(`\u2514\u2500\u2500 +${more} more\u2026`, width)));
  return lines.filter(Boolean);
}
