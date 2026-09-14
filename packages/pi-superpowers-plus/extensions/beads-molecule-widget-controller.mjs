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
      warn("[pi-superpowers-plus] molecule widget render failed:", err);
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
      if (gen === refreshGen) warn("[pi-superpowers-plus] molecule refresh failed:", err);
      return;
    }
    if (gen !== refreshGen) return;

    if (r?.code !== 0) {
      const next = applyErrorFrame(activeMolecule, lockedMoleculeId, r);
      activeMolecule = next.activeMolecule;
      lockedMoleculeId = next.lockedMoleculeId;
      if (!isCleanNotFound(r)) warn("[pi-superpowers-plus] molecule refresh error:", r);
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
