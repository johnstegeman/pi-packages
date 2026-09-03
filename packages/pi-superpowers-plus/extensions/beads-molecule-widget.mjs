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
  return out + "\u2026";
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
export function formatAge(startedAt, now = Date.now()) {
  const t = Date.parse(startedAt ?? "");
  if (!Number.isFinite(t)) return "";
  const min = Math.floor((now - t) / 60000);
  if (!Number.isFinite(min) || min < 0) return "";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
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
  if (!obj || !obj.molecule_id || !Array.isArray(obj.steps)) return null;
  const doneCount = obj.steps.filter((s) => s.status === "done").length;
  return {
    molecule_id: obj.molecule_id,
    molecule_title: obj.molecule_title ?? "",
    current_step: obj.current_step ?? null,
    next_step: obj.next_step ?? null,
    steps: obj.steps,
    doneCount,
    total: obj.steps.length,
  };
}

/**
 * Parse `bd mol show <step> --json` output into the step's child beads.
 * Children are the `issues[]` entries reachable via a `dependencies[]` edge of
 * type "parent-child" whose `depends_on_id` equals the graph root's id.
 * Sorted deterministically by `created_at` (fallback "") then `id`.
 * Returns null on any malformed input; an empty array is valid (no children).
 */
export function parseMoleculeShow(json) {
  let obj;
  try {
    const text = typeof json === "string" ? json.trim() : json;
    obj = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  if (!obj || !obj.root || obj.root.id == null || !Array.isArray(obj.issues) || !Array.isArray(obj.dependencies)) {
    return null;
  }
  const byId = new Map(obj.issues.map((it) => [it && it.id, it]));
  const childIds = obj.dependencies
    .filter((d) => d && d.depends_on_id === obj.root.id && d.type === "parent-child")
    .map((d) => d.issue_id);
  const kids = childIds
    .map((id) => byId.get(id))
    .filter((it) => it && it.id != null)
    .map((it) => ({
      id: it.id,
      title: it.title ?? "",
      status: it.status ?? "open",
      priority: it.priority,
      issue_type: it.issue_type ?? "task",
      created_at: it.created_at ?? "",
    }));
  kids.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return kids;
}


const PLAIN_FG = (_c, t) => t;
function themeOf(theme) {
  return theme && typeof theme.fg === "function" ? (c, t) => theme.fg(c, t) : PLAIN_FG;
}

/** Render the molecule widget. Returns [] when there's nothing to draw. */
export function moleculeWidgetLines(state, width, theme) {
  const fg = themeOf(theme);
  if (!state || !Array.isArray(state.steps) || state.steps.length === 0 || !(width > 0)) return [];

  // view B header: accent label + muted title + muted done/total suffix (no phase label)
  const header = assemble(
    [
      { text: "Superpowers:", paint: (t) => fg("accent", t) },
      { text: ` ${state.molecule_title}`, paint: (t) => fg("muted", t) },
      { text: ` \u00b7 ${state.doneCount}/${state.total}`, paint: (t) => fg("muted", t) },
    ],
    width,
  ).text;

  const rows = [];
  const current = state.current_step;
  if (current && current.issue_type === "gate") {
    // gate trunk: pause glyph + "Waiting on you", never a subtree
    rows.push(
      assemble(
        [
          { text: "\u23f8 Waiting on you: ", paint: (t) => fg("warning", t) },
          { text: current.title ?? "", paint: (t) => fg("text", t) },
        ],
        width,
      ).text,
    );
  } else if (current) {
    const frags = [
      { text: `${markerFor(current.status)} `, paint: (t) => fg("warning", t) },
      { text: `${current.id ?? ""} `, paint: (t) => fg("text", t) },
    ];
    if (current.priority != null) frags.push({ text: `\u25cf P${current.priority} `, paint: (t) => fg("warning", t) });
    frags.push({ text: current.title ?? "", paint: (t) => fg("text", t) });
    rows.push(assemble(frags, width).text);
  } else if (state.next_step) {
    rows.push(
      assemble(
        [
          { text: "\u25cb Next: ", paint: (t) => fg("dim", t) },
          { text: state.next_step.title ?? "", paint: (t) => fg("text", t) },
        ],
        width,
      ).text,
    );
  }

  // children subtree: glyph rows + 15-line cap. header+trunk always win; the
  // remaining (MAX_LINES-2) slots hold children, and when they overflow the
  // last of those slots becomes the muted `└── +N more…` tail so the total
  // number of lines never exceeds MAX_LINES.
  const MAX_LINES = 15;
  const SLOTS = MAX_LINES - 2;
  if (current && current.issue_type !== "gate") {
    let kids = state.children ?? [];
    let more = 0;
    if (kids.length > SLOTS) {
      more = kids.length - (SLOTS - 1);
      kids = kids.slice(0, SLOTS - 1);
    }
    kids.forEach((kid, i) => {
      const last = i === kids.length - 1;
      const frags = [
        { text: last ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ", paint: (t) => fg("muted", t) },
        { text: `${markerFor(kid.status)} `, paint: (t) => fg(kid.status === "closed" ? "text" : "warning", t) },
        { text: `${kid.id ?? ""} `, paint: (t) => fg("text", t) },
      ];
      if (kid.priority != null) frags.push({ text: `\u25cf P${kid.priority} `, paint: (t) => fg("warning", t) });
      frags.push({ text: kid.title ?? "", paint: (t) => fg("text", t) });
      rows.push(assemble(frags, width).text);
    });
    if (more > 0) rows.push(fg("muted", truncToWidth(`\u2514\u2500\u2500 +${more} more\u2026`, width)));
  }

  return [header, ...rows].filter(Boolean);
}
