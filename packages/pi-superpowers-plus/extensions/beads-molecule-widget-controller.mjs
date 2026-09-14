import {
  applyErrorFrame,
  applyMoleculeFrame,
  createChangeCoalescer,
  hasLockedMolecule,
  isCleanNotFound,
  moleculeWidgetLines,
  nextRefreshArgs,
  parseMoleculeCurrent,
} from "./beads-molecule-widget.mjs";

const MAX_LOG_TEXT = 200;

/**
 * Bounded, sanitized log fragment: replaces control characters (including ANSI
 * escape bytes) with spaces and caps length, so raw bd stdout/stderr and thrown
 * errors can't inject control sequences into the terminal log. Filtering by code
 * point avoids embedding literal control chars in the source or a regex.
 */
function sanitizeLogText(value) {
  let out = "";
  for (const ch of String(value ?? "")) {
    const cp = ch.codePointAt(0);
    out += cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) ? " " : ch;
  }
  return out.slice(0, MAX_LOG_TEXT);
}

/**
 * Session-scoped lifecycle controller for the molecule widget. Owns the mutable
 * refresh state, the coalesced change trigger, the beads:changed subscription,
 * and the generation guard that makes overlapping refreshes last-write-wins.
 * Knows nothing about pi: every external effect is injected.
 */
export function createMoleculeWidgetController({
  exec,
  subscribeChanges,
  warn = console.warn,
  windowMs = 10000,
  timers,
}) {
  let ui = null;
  let cwd = null;
  let activeMolecule = null;
  let lockedMoleculeId = null;
  let refreshGen = 0;
  let coalescer = null;
  let unsubscribe = null;

  function render() {
    try {
      if (!ui?.setWidget) return;
      if (!activeMolecule) {
        ui.setWidget("beads-mol", undefined);
        return;
      }
      ui.setWidget(
        "beads-mol",
        (_tui, theme) => ({
          render: (width) => moleculeWidgetLines(activeMolecule, width - 1, ui?.theme ?? theme).map((l) => ` ${l}`),
        }),
        { placement: "aboveEditor" },
      );
    } catch (err) {
      warn("[pi-superpowers-plus] molecule widget render failed:", sanitizeLogText(err?.message ?? err));
    }
  }

  async function refresh() {
    if (!cwd) return;
    const gen = ++refreshGen;
    const queriedById = hasLockedMolecule(lockedMoleculeId);
    const args = nextRefreshArgs(lockedMoleculeId);

    let r;
    try {
      r = await exec("bd", args, { cwd, timeout: 5000 });
    } catch (err) {
      if (gen === refreshGen)
        warn("[pi-superpowers-plus] molecule refresh failed:", sanitizeLogText(err?.message ?? err));
      return;
    }
    if (gen !== refreshGen) return;

    if (r?.code !== 0) {
      const next = applyErrorFrame(activeMolecule, lockedMoleculeId, r);
      activeMolecule = next.activeMolecule;
      lockedMoleculeId = next.lockedMoleculeId;
      if (!isCleanNotFound(r))
        warn(
          "[pi-superpowers-plus] molecule refresh error:",
          r?.code,
          sanitizeLogText(`${r?.stdout ?? ""}\n${r?.stderr ?? ""}`),
        );
      return;
    }

    const parsed = parseMoleculeCurrent(r.stdout);
    const next = applyMoleculeFrame(activeMolecule, lockedMoleculeId, parsed, queriedById);
    activeMolecule = next.activeMolecule;
    lockedMoleculeId = next.lockedMoleculeId;
  }

  function refreshAndRender() {
    void refresh().then(render, render);
  }

  function triggerChange() {
    coalescer?.trigger();
  }

  function bindSession({ ui: nextUi, cwd: nextCwd }) {
    ui = nextUi ?? null;
    cwd = nextCwd ?? cwd;
    if (!unsubscribe) {
      unsubscribe = subscribeChanges(triggerChange) ?? null;
    }
    if (!coalescer) {
      coalescer = createChangeCoalescer(refreshAndRender, windowMs, timers, warn);
    }
    refreshAndRender();
  }

  function setCwd(nextCwd) {
    cwd = nextCwd ?? cwd;
    refreshAndRender();
  }

  function unbindSession() {
    coalescer?.cancel();
    coalescer = null;
    unsubscribe?.();
    unsubscribe = null;
    ui = null;
    activeMolecule = null;
    lockedMoleculeId = null;
    refreshGen++;
  }

  return { bindSession, unbindSession, setCwd, refresh, render, triggerChange };
}
