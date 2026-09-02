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

const PHASE_MAP = {
  explore: "Brainstorming",
  clarify: "Brainstorming",
  approaches: "Brainstorming",
  design: "Brainstorming",
  "design-approved": "Brainstorming",
  "write-spec": "Spec",
  "spec-review": "Spec",
  "spec-approved": "Spec",
  implement: "Implementing",
  verify: "Verifying",
  "smoke-test-approved": "Verifying",
  finish: "Finishing",
};
function phaseOf(step) {
  if (!step) return "Working";
  return PHASE_MAP[step.formula_step_id] ?? "Implementing";
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

const PLAIN_FG = (_c, t) => t;
function themeOf(theme) {
  return theme && typeof theme.fg === "function" ? (c, t) => theme.fg(c, t) : PLAIN_FG;
}

/** Render the molecule widget. Returns [] when there's nothing to draw. */
export function moleculeWidgetLines(state, width, theme) {
  const fg = themeOf(theme);
  if (!state || !Array.isArray(state.steps) || state.steps.length === 0 || !(width > 0)) return [];

  const phase = phaseOf(state.current_step ?? state.next_step);
  const header = assemble(
    [
      { text: "\u29BF ", paint: (t) => fg("accent", t) },
      { text: phase, paint: (t) => fg("accent", t) },
      {
        text: ` \u00b7 ${state.molecule_title} \u00b7 ${state.doneCount}/${state.total}`,
        paint: (t) => fg("muted", t),
      },
    ],
    width,
  );

  const rows = [];
  if (state.current_step) {
    const isGate = state.current_step.issue_type === "gate";
    const age = state.current_step.started_at ? formatAge(state.current_step.started_at) : "";
    rows.push(
      assemble(
        [
          { text: isGate ? "\u23f8 " : "\u25d0 ", paint: (t) => fg("warning", t) },
          { text: isGate ? "Waiting on you: " : "", paint: (t) => fg("warning", t) },
          { text: state.current_step.title ?? "", paint: (t) => fg("text", t) },
          { text: age ? `  ${age}` : "", paint: (t) => fg("dim", t) },
        ],
        width,
      ).text,
    );
  } else if (state.next_step) {
    rows.push(
      assemble(
        [
          { text: "\u25e6 Next: ", paint: (t) => fg("dim", t) },
          { text: state.next_step.title ?? "", paint: (t) => fg("text", t) },
        ],
        width,
      ).text,
    );
  }

  const pendingCount = state.steps.filter((s) => s.status === "blocked" || s.status === "pending").length;
  if (pendingCount > 0) rows.push(fg("dim", truncToWidth(`+${pendingCount} pending`, width)));

  return [header.text, ...rows].filter(Boolean);
}
