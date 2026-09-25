import {
  applyErrorFrame,
  applyMoleculeFrame,
  createChangeCoalescer,
  hasLockedMolecule,
  isCleanNotFound,
  moleculeWidgetLines,
  nextRefreshArgs,
  parseMoleculeCurrent,
  parseMoleculeCurrents,
  parseMoleculeRoots,
  pickWorkspaceMolecule,
} from "./beads-molecule-widget.mjs";
import { createContentionGate } from "./molecule-contention-gate.mjs";

const MAX_LOG_TEXT = 200;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const READINESS_MARGIN_MS = 20_000;
const MIN_TIMEOUT_MS = 30_000;

/**
 * Resolve the per-bd-query timeout. `PI_BEADS_MOLECULE_TIMEOUT_MS` (positive
 * integer ms) wins outright; otherwise derive from bd's own embedded-Dolt
 * readiness wait (`BEADS_DOLT_READY_TIMEOUT`, positive integer seconds,
 * default 10) plus a margin, floored at 30 s so the widget can never fire
 * before bd itself would give up.
 */
export function resolveBdTimeout(env = process.env) {
  const override = Number.parseInt(env?.PI_BEADS_MOLECULE_TIMEOUT_MS ?? "", 10);
  if (Number.isInteger(override) && override > 0) return override;
  const readySecs = Number.parseInt(env?.BEADS_DOLT_READY_TIMEOUT ?? "", 10);
  const readyMs = Number.isInteger(readySecs) && readySecs >= 1 ? readySecs * 1000 : DEFAULT_READY_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, readyMs + READINESS_MARGIN_MS);
}

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
  timeoutMs = resolveBdTimeout(),
  contentionGate = null,
  now = () => Date.now(),
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

  // All bd calls cross this gate, so a contention cooldown suppresses the whole
  // refresh (workspace probe + per-root loop) instead of re-taking the lock.
  const gate =
    contentionGate ??
    createContentionGate({
      exec,
      now,
      sleep: (ms) => new Promise((resolve) => (timers?.setTimeout ?? setTimeout)(resolve, ms)),
    });

  async function safeExec(args, gen, { force = false } = {}) {
    // "contended" maps onto the existing null sentinel: callers keep the prior
    // frame with no warn. Genuine errors keep their warn paths.
    const r = await gate.run(args, { cwd, timeout: timeoutMs }, { force });
    if (r.status === "contended") return null;
    if (r.status === "error") {
      if (gen === refreshGen)
        warn(
          "[pi-superpowers-plus] molecule refresh failed:",
          sanitizeLogText(r.error?.message ?? r.error),
        );
      return null;
    }
    return r.result;
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

  async function refreshWorkspace(gen, { force = false } = {}) {
    const listR = await safeExec(
      ["list", "--type", "molecule", "--label", `ws:${activeWorkspaceKey}`, "--json"],
      gen,
      { force },
    );
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
      // Multi-worktree guard: if any ws:-stamped open molecule exists and none is
      // ours (found.length === 0), another worktree owns an active cycle — never
      // adopt an unscoped global candidate in that case.
      const anyWs = await safeExec(
        ["list", "--type", "molecule", "--label-pattern", "ws:*", "--json"],
        gen,
        { force },
      );
      if (gen !== refreshGen) return;
      if (!anyWs || anyWs.code !== 0) return; // can't confirm; keep prior frame, never adopt unscoped global
      if (parseMoleculeRoots(anyWs.stdout).length > 0) {
        clearFrame();
        return;
      }
      const gR = await safeExec(["mol", "current", "--json"], gen, { force });
      if (gen !== refreshGen || !gR) return;
      if (gR.code !== 0) {
        if (isCleanNotFound(gR)) clearFrame();
        else
          warn(
            "[pi-superpowers-plus] molecule workspace fallback error:",
            gR.code,
            sanitizeLogText(`${gR.stdout ?? ""}\n${gR.stderr ?? ""}`),
          );
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
      const r = await safeExec(["mol", "current", root.id, "--json"], gen, { force });
      if (gen !== refreshGen) return;
      if (!r) {
        sawError = true;
        continue;
      }
      if (r.code !== 0) {
        if (!isCleanNotFound(r)) {
          warn(
            "[pi-superpowers-plus] molecule workspace root query error:",
            root.id,
            r.code,
            sanitizeLogText(`${r.stdout ?? ""}\n${r.stderr ?? ""}`),
          );
          sawError = true;
        }
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

  async function refresh({ force = false } = {}) {
    if (!cwd) return;
    const gen = ++refreshGen;

    if (hasLockedMolecule(lockedMoleculeId)) {
      const r = await safeExec(nextRefreshArgs(lockedMoleculeId), gen, { force });
      if (gen !== refreshGen) return;
      applySingleResult(r, true);
      return;
    }

    if (!activeWorkspaceKey) {
      const r = await safeExec(nextRefreshArgs(null), gen, { force });
      if (gen !== refreshGen) return;
      applySingleResult(r, false);
      return;
    }

    await refreshWorkspace(gen, { force });
  }

  function refreshAndRender({ force = false } = {}) {
    void refresh({ force }).then(render, render);
  }

  function triggerChange() {
    coalescer?.trigger();
  }

  // Apply a workspace-key change: a key that actually changed drops the
  // previous worktree's frame + lock so it cannot leak into the new workspace.
  function applyWorkspaceKey(nextKey) {
    if (nextKey !== undefined) {
      if (nextKey !== activeWorkspaceKey) clearFrame();
      activeWorkspaceKey = nextKey;
    }
  }

  // `initialRefresh: false` binds the session without issuing a `bd` query.
  // The adapter passes it so pi startup never touches the beads DB; the first
  // `beads:changed`/`superpowers:phase` event (or an explicit refresh) paints.
  function bindSession({ ui: nextUi, cwd: nextCwd, workspaceKey: nextKey, initialRefresh = true }) {
    ui = nextUi ?? null;
    cwd = nextCwd ?? cwd;
    applyWorkspaceKey(nextKey);
    if (!unsubscribe) {
      unsubscribe = subscribeChanges(triggerChange) ?? null;
    }
    if (!coalescer) {
      coalescer = createChangeCoalescer(refreshAndRender, windowMs, timers, warn);
    }
    if (initialRefresh) refreshAndRender();
    else render();
  }

  // By default setCwd updates the cwd AND refreshes (the adapter calls it on
  // every agent_start as a per-turn backstop). Pass `refresh: false` to update
  // the cwd without querying beads.
  function setCwd(nextCwd, { refresh: doRefresh = true, workspaceKey: nextKey } = {}) {
    applyWorkspaceKey(nextKey);
    cwd = nextCwd ?? cwd;
    if (doRefresh) refreshAndRender({ force: true }); // agent_start: one probe per turn
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
