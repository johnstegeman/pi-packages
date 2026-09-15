import {
  applyErrorFrame,
  applyMoleculeFrame,
  createChangeCoalescer,
  hasLockedMolecule,
  isCleanNotFound,
  moleculeWidgetLines,
  parseMoleculeCurrent,
  parseMoleculeCurrents,
  parseMoleculeRoots,
  pickWorkspaceMolecule,
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
  let activeWorkspaceKey = null;

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

  async function safeExec(args) {
    try {
      return await exec("bd", args, { cwd, timeout: 5000 });
    } catch (err) {
      warn("[pi-superpowers-plus] molecule refresh failed:", sanitizeLogText(err?.message ?? err));
      return null;
    }
  }

  function applySingleResult(r, queriedById) {
    if (!r) return;
    if (r.code !== 0) {
      const next = applyErrorFrame(activeMolecule, lockedMoleculeId, r);
      activeMolecule = next.activeMolecule;
      lockedMoleculeId = next.lockedMoleculeId;
      if (!isCleanNotFound(r))
        warn(
          "[pi-superpowers-plus] molecule refresh error:",
          r.code,
          sanitizeLogText(`${r.stdout ?? ""}\n${r.stderr ?? ""}`),
        );
      return;
    }
    const parsed = parseMoleculeCurrent(r.stdout);
    const next = applyMoleculeFrame(activeMolecule, lockedMoleculeId, parsed, queriedById);
    activeMolecule = next.activeMolecule;
    lockedMoleculeId = next.lockedMoleculeId;
  }

  function adoptFrame(frame, queriedById) {
    const next = applyMoleculeFrame(activeMolecule, lockedMoleculeId, frame, queriedById);
    activeMolecule = next.activeMolecule;
    lockedMoleculeId = next.lockedMoleculeId;
  }

  function clearFrame() {
    activeMolecule = null;
    lockedMoleculeId = null;
  }

  async function refreshWorkspace(gen) {
    const listR = await safeExec(["list", "--type", "molecule", "--label", `ws:${activeWorkspaceKey}`, "--json"]);
    if (gen !== refreshGen) return;
    if (!listR) return; // exec threw; safeExec warned, keep the prior frame
    if (listR.code !== 0) {
      if (isCleanNotFound(listR)) clearFrame();
      else
        warn(
          "[pi-superpowers-plus] molecule workspace query error:",
          listR.code,
          sanitizeLogText(`${listR.stdout ?? ""}\n${listR.stderr ?? ""}`),
        );
      return;
    }
    const found = parseMoleculeRoots(listR.stdout);
    if (found.length === 0) {
      const gR = await safeExec(["mol", "current", "--json"]);
      if (gen !== refreshGen || !gR) return;
      if (gR.code !== 0) {
        if (isCleanNotFound(gR)) clearFrame();
        return;
      }
      const frames = parseMoleculeCurrents(gR.stdout);
      if (frames.length === 1) adoptFrame(frames[0], false);
      else clearFrame();
      return;
    }
    const candidates = [];
    let sawError = false;
    for (const root of found) {
      const r = await safeExec(["mol", "current", root.id, "--json"]);
      if (gen !== refreshGen) return;
      if (!r || r.code !== 0) {
        if (!r || !isCleanNotFound(r)) sawError = true;
        continue;
      }
      const frame = parseMoleculeCurrent(r.stdout);
      if (frame) candidates.push({ frame, updatedAt: root.updated_at });
    }
    const chosen = pickWorkspaceMolecule(candidates);
    if (chosen) adoptFrame(chosen, true);
    else if (sawError) {
      // transient per-root failure: keep the prior frame
    } else clearFrame();
  }

  async function refresh() {
    if (!cwd) return;
    const gen = ++refreshGen;

    if (hasLockedMolecule(lockedMoleculeId)) {
      const r = await safeExec(["mol", "current", lockedMoleculeId, "--json"]);
      if (gen !== refreshGen) return;
      applySingleResult(r, true);
      return;
    }

    if (!activeWorkspaceKey) {
      const r = await safeExec(["mol", "current", "--json"]);
      if (gen !== refreshGen) return;
      applySingleResult(r, false);
      return;
    }

    await refreshWorkspace(gen);
  }

  function refreshAndRender() {
    void refresh().then(render, render);
  }

  function triggerChange() {
    coalescer?.trigger();
  }

  // `initialRefresh: false` binds the session without issuing a `bd` query.
  // The adapter passes it so pi startup never touches the beads DB; the first
  // `beads:changed`/`superpowers:phase` event (or an explicit refresh) paints.
  function bindSession({ ui: nextUi, cwd: nextCwd, workspaceKey: nextKey, initialRefresh = true }) {
    ui = nextUi ?? null;
    cwd = nextCwd ?? cwd;
    if (nextKey !== undefined) {
      if (nextKey !== activeWorkspaceKey) clearFrame();
      activeWorkspaceKey = nextKey;
    }
    if (!unsubscribe) {
      unsubscribe = subscribeChanges(triggerChange) ?? null;
    }
    if (!coalescer) {
      coalescer = createChangeCoalescer(refreshAndRender, windowMs, timers, warn);
    }
    if (initialRefresh) refreshAndRender();
    else render();
  }

  // `refresh: false` updates the cwd without querying beads (pi turns call this
  // on every agent_start; only an actual bead change should spend a `bd` call).
  function setCwd(nextCwd, { refresh: doRefresh = true, workspaceKey: nextKey } = {}) {
    if (nextKey !== undefined) {
      if (nextKey !== activeWorkspaceKey) clearFrame();
      activeWorkspaceKey = nextKey;
    }
    cwd = nextCwd ?? cwd;
    if (doRefresh) refreshAndRender();
    else render();
  }

  function unbindSession() {
    coalescer?.cancel();
    coalescer = null;
    unsubscribe?.();
    unsubscribe = null;
    ui = null;
    activeMolecule = null;
    lockedMoleculeId = null;
    activeWorkspaceKey = null;
    refreshGen++;
  }

  return { bindSession, unbindSession, setCwd, refresh, render, triggerChange };
}
