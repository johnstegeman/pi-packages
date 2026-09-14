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
      labels: Array.isArray(s.issue.labels) ? s.issue.labels : [],
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
    total: steps.length,
  };
}

/**
 * True when a molecule lock is actually usable: null, undefined, or an empty
 * string all mean "no lock" (a blank id is never a valid query target). Both
 * nextRefreshArgs and the controller's refresh() use this single predicate so
 * the should-query-by-id decision can never drift between the two call sites.
 */
export function hasLockedMolecule(lockedMoleculeId) {
  return lockedMoleculeId != null && lockedMoleculeId !== "";
}

/**
 * Choose the `bd mol current` args for a refresh. Once a usable molecule id is
 * known, query by id — with-id mode always returns the full molecule even when
 * every step is done — instead of the no-id inference call, which drops out to
 * [] in the post-implementation window (nothing in_progress+assigned to infer
 * from). A null / undefined / empty lock falls back to no-id inference.
 */
export function nextRefreshArgs(lockedMoleculeId) {
  return hasLockedMolecule(lockedMoleculeId)
    ? ["mol", "current", lockedMoleculeId, "--json"]
    : ["mol", "current", "--json"];
}

/**
 * Pure transition for one refresh result. Returns the next
 * `{ activeMolecule, lockedMoleculeId }`:
 * - parsed non-null: adopt the new frame and lock its molecule id — unless the
 *   molecule is fully done (every step done, nothing current), in which case
 *   the finished frame is kept for display but the lock is dropped so the next
 *   refresh falls back to no-id inference and can pick up a newly poured
 *   molecule (otherwise the widget would stay pinned to the finished molecule).
 * - parsed null + queriedById: real "molecule gone" — clear the widget and the lock;
 * - parsed null + no-id fallback (no lock yet): inference found nothing, keep the
 *   previous frame as-is (nothing better to show).
 */
export function applyMoleculeFrame(prevActiveMolecule, prevLockedId, parsed, queriedById) {
  if (parsed) {
    const finished = parsed.doneCount === parsed.total && !parsed.current_step;
    return finished
      ? { activeMolecule: parsed, lockedMoleculeId: null }
      : { activeMolecule: parsed, lockedMoleculeId: parsed.molecule_id };
  }
  if (queriedById) return { activeMolecule: null, lockedMoleculeId: null };
  return { activeMolecule: prevActiveMolecule, lockedMoleculeId: prevLockedId };
}

/**
 * True only for bd's clean "this molecule is gone" signals. Considers both
 * output streams (bd writes some errors on stdout). Requires "molecule" and
 * "not found" on the same line, so "molecule" in stdout cannot pair with
 * "not found" in stderr. A bare "not found" — e.g. `bd: command not found` —
 * is NOT a clean signal.
 */
export function isCleanNotFound(r) {
  if (!r) return false;
  const msg = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return /no active molecule/i.test(msg) || /\bmolecule\b[^\n]*\bnot found\b/i.test(msg);
}

/**
 * Pure transition for a non-zero `bd mol current` result. Only a clean
 * not-found / no-active signal clears the widget AND the lock (which lets the
 * next refresh re-infer a fresh molecule); arbitrary or transient failures keep
 * both — an unreachable bd binary must not blank a widget that was showing real
 * progress a moment ago.
 */
export function applyErrorFrame(prevActiveMolecule, prevLockedId, r) {
  if (!r) return { activeMolecule: prevActiveMolecule, lockedMoleculeId: prevLockedId };
  if (isCleanNotFound(r)) {
    return { activeMolecule: null, lockedMoleculeId: null };
  }
  return { activeMolecule: prevActiveMolecule, lockedMoleculeId: prevLockedId };
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
 * cancel() clears the pending window and dirty flag; a later trigger() is
 * again a fresh leading edge. A throwing onFire is routed to warn instead of
 * wedging the timer chain. The warn parameter defaults to console.warn so the
 * 3-arg form keeps working; callers may inject their own.
 */
export function createChangeCoalescer(
  onFire,
  windowMs = 10000,
  timers = { setTimeout, clearTimeout },
  warn = console.warn,
) {
  let timer = null;
  let dirty = false;

  function fire() {
    try {
      onFire();
    } catch (err) {
      warn("[pi-superpowers-plus] coalescer onFire threw:", err);
    }
  }

  function scheduleTick() {
    timer = timers.setTimeout(() => {
      if (dirty) {
        dirty = false;
        fire();
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
        fire();
        scheduleTick();
      } else {
        dirty = true;
      }
    },
    cancel() {
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      dirty = false;
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

/** Plan-order chain for the current phase (brainstorm/finish views; implement head + kids). */
function chainForPhase(state, phase) {
  if (phase === "brainstorming") return resolveRows(state.steps, BRAINSTORM_VIEW).map((v) => v.step);
  if (phase === "finishing") return resolveRows(state.steps, FINISH_VIEW).map((v) => v.step);
  const impl = state.steps.find((s) => /^Implement( |$)/.test(s.title ?? ""));
  if (!impl) return [];
  return [
    impl,
    ...state.steps
      .filter((s) => s.id.startsWith(`${impl.id}.`))
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
      ),
  ];
}

/** Human gates (by formula label) → the review step each one blocks. */
export const GATE_TO_REVIEW_STEP = {
  "step:gate-design-approved": "User approves design",
  "step:gate-spec-approved": "User reviews written spec",
  "step:gate-smoke-test-approved": "Smoke test / manual QA sign-off",
};

/**
 * The step the workflow is genuinely waiting on the user to review, or null.
 * Order-independent: uses the phase's chain order (not bd's array order) and the
 * gate labels to associate a gate with its gated review step. Returns null whenever
 * any task step is in progress, the first open step isn't a gated review step,
 * or the gated review step's gate is closed.
 */
export function waitingReviewStep(state, chainOrder) {
  if (!state || !Array.isArray(state.steps)) return null;
  const inProgress = state.steps.some((s) => s.step_status === "current" || s.status === "in_progress");
  if (inProgress) return null;
  const firstOpen = chainOrder.find((s) => s.step_status !== "done" && s.status !== "closed");
  if (!firstOpen) return null;
  const label = Object.keys(GATE_TO_REVIEW_STEP).find((l) => GATE_TO_REVIEW_STEP[l] === firstOpen.title);
  if (!label) return null;
  const gate = state.steps.find((s) => s.issue_type === "gate" && Array.isArray(s.labels) && s.labels.includes(label));
  if (!gate || gate.status !== "open") return null;
  return firstOpen;
}

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

  // Awaiting-the-user line: a genuine wait only — either the current step IS a
  // human gate, or a gated human-review step is the actual next open step with
  // nothing in progress (order-independent; gates are "ready" whenever open, so
  // gate readiness alone never proves a wait).
  const gateCurrent = state.current_step && state.current_step.issue_type === "gate";
  const chainOrder = chainForPhase(state, phase);
  const awaitingStep = gateCurrent ? null : waitingReviewStep(state, chainOrder);
  const awaitingLine =
    gateCurrent || awaitingStep
      ? {
          text: assemble(
            [
              { text: "\u23f8 Waiting on you: ", paint: (t) => fg("warning", t) },
              { text: (awaitingStep ?? state.current_step)?.title ?? "", paint: (t) => fg("text", t) },
              { text: `  ${(awaitingStep ?? state.current_step)?.id ?? ""}`, paint: (t) => fg("muted", t) },
            ],
            width,
          ).text,
          closed: false,
          pinned: true,
        }
      : null;

  // Close-as-you-go fallback "current" step: when the previous step was just closed
  // and its successor isn't claimed yet, bd reports NO is_current step for a moment
  // and the widget would otherwise show nothing as active. Pick the DEEPEST (last in
  // render order) open/ready non-gate step of the view's render set and let it lead —
  // unless an awaiting (gated) step already leads, or an is_current step is present
  // (a real is_current step always wins).
  const leadCandidate = (set) => {
    // A real current step always wins; so does a waiting (gated) step, and a gate
    // that IS the current step pins the ⏸ row on its own — never fall back then.
    if (awaitingStep || gateCurrent || set.some((s) => s.is_current)) return null;
    for (let i = set.length - 1; i >= 0; i--) {
      const s = set[i];
      if (s.status === "open" && s.issue_type !== "gate" && (s.step_status === "ready" || s.step_status === "open"))
        return s;
    }
    return null;
  };
  if (gateCurrent) rows.push(awaitingLine);

  const stepRow = (step, label, lead) => {
    const active = step === awaitingStep || (lead && step === lead);
    return {
      text: assemble(
        [
          {
            text: `${active ? "\u25d0" : markerFor(step.status)} `,
            paint: (t) => fg(step.status === "closed" ? "text" : "warning", t),
          },
          { text: ` ${step.id ?? ""}`, paint: (t) => fg("muted", t) },
          { text: ` ${label ?? step.title ?? ""}`, paint: (t) => fg(step.status === "closed" ? "muted" : "text", t) },
        ],
        width,
      ).text,
      closed: step.status === "closed",
      pinned: !!(step.is_current || active),
    };
  };

  if (phase === "brainstorming") {
    const view = resolveRows(state.steps, BRAINSTORM_VIEW);
    const lead = leadCandidate(view.map((v) => v.step));
    for (const s of view) rows.push(stepRow(s.step, s.label, lead));
  } else if (phase === "implementing") {
    const [impl, ...kids] = chainOrder;
    if (impl) rows.push(stepRow(impl));
    // Kids only ever lead when the impl head is NOT the current step — when the
    // head carries is_current its ◐ must be the only active row.
    const lead = impl.is_current ? null : leadCandidate(kids);
    kids.forEach((kid, i) => {
      const last = i === kids.length - 1;
      const activeKid = kid === awaitingStep || kid === lead;
      rows.push({
        text: assemble(
          [
            { text: last ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ", paint: (t) => fg("muted", t) },
            {
              text: `${activeKid ? "\u25d0" : markerFor(kid.status)} `,
              paint: (t) => fg(kid.status === "closed" ? "text" : "warning", t),
            },
            { text: `${kid.id ?? ""} `, paint: (t) => fg("muted", t) },
            { text: kid.title ?? "", paint: (t) => fg(kid.status === "closed" ? "muted" : "text", t) },
          ],
          width,
        ).text,
        closed: kid.status === "closed",
        pinned: !!(kid.is_current || activeKid),
      });
    });
  } else if (phase === "finishing") {
    const view = resolveRows(state.steps, FINISH_VIEW);
    const lead = leadCandidate(view.map((v) => v.step));
    for (const s of view) rows.push(stepRow(s.step, s.label, lead));
  }

  // Awaiting line when nothing is in progress goes after the view rows, so the
  // awaited human-review step reads as the active row (a gate that IS the current
  // step keeps its top placement above the checklist).
  if (!gateCurrent && awaitingLine) rows.push(awaitingLine);

  const { kept, more } = fitRows(rows);
  const lines = [header, ...kept.map((r) => r.text)];
  if (more > 0) lines.push(fg("muted", truncToWidth(`\u2514\u2500\u2500 +${more} more\u2026`, width)));
  return lines.filter(Boolean);
}
