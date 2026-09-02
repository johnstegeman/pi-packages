import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { moleculeWidgetLines, parseMoleculeCurrent, parseMoleculeShow } from "./beads-molecule-widget.mjs";

/** A child bead of the current step, as produced by `parseMoleculeShow`. */
type ChildBead = {
  id: string;
  title: string;
  status: string;
  priority?: number;
  issue_type: string;
  created_at?: string;
};

type MoleculeState = ReturnType<typeof parseMoleculeCurrent> & {
  /** children of the current step, attached by refreshChildren — `mol current` never emits these */
  children?: ChildBead[];
};

export default function (pi: ExtensionAPI) {
  let uiRef: any = null;
  let activeMolecule: MoleculeState | null = null;

  // ---- live-poll state: one interval for the extension's lifetime ----
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastStepId: string | null = null; // current-step id last seen by the child fetch
  let forceChildren = false; // invalidate/refresh forces a child re-fetch even if the step is unchanged
  let timersStarted = false; // guards against double-registering the interval

  // The poll head: `bd mol current --json` runs on every tick so a fresh pour
  // appears ≤5s. `bd mol show` is heavier, so it stays in the gated
  // refreshChildren below (steady state = one subprocess per tick).
  async function refreshMolecule(cwd: string): Promise<void> {
    const r = await pi.exec("bd", ["mol", "current", "--json"], {
      cwd,
      timeout: 5000,
    });
    if (!r || r.code !== 0) {
      // only clear on a clean "no active molecule" signal, never on a transient
      // failure — an unreachable `bd` binary should not blank a widget that was
      // showing real progress a moment ago.
      if (r && /no active molecule|not found/i.test(r.stderr ?? "")) activeMolecule = null;
      return;
    }
    const parsed = parseMoleculeCurrent(r.stdout);
    if (parsed) {
      // A fresh parse carries no `children`; carry the last known subtree forward
      // when the current step is unchanged (children are cached alongside
      // activeMolecule), so a steady tick never blanks it and a failed `mol show`
      // can't erase the last known children.
      if (
        activeMolecule &&
        activeMolecule.children &&
        parsed.current_step?.id === activeMolecule.current_step?.id
      ) {
        parsed.children = activeMolecule.children;
      }
      activeMolecule = parsed;
    }
  }

  // Gated child fetch: attaches `bd mol show <step> --json` children to the
  // active molecule for the renderer, but only when the current step id changed
  // or a refresh was forced. On failure it leaves the last known children in
  // place and never throws. forceChildren is always cleared once a fetch is
  // attempted.
  async function refreshChildren(cwd: string): Promise<void> {
    if (!activeMolecule || !activeMolecule.current_step?.id) return;
    if (!forceChildren && activeMolecule.current_step.id === lastStepId) return;
    const mol = activeMolecule;
    const r = await pi.exec("bd", ["mol", "show", mol.current_step.id, "--json"], {
      cwd,
      timeout: 5000,
    });
    if (r && r.code === 0) {
      const kids = parseMoleculeShow(r.stdout);
      if (kids) mol.children = kids; // attach for the renderer (never overwrite the whole state)
      lastStepId = mol.current_step.id ?? null;
    }
    forceChildren = false;
  }

  function renderMolecule() {
    try {
      if (!uiRef?.setWidget) return;
      if (!activeMolecule) {
        uiRef.setWidget("beads-mol", undefined);
        return;
      }
      uiRef.setWidget(
        "beads-mol",
        (_tui: any, theme: any) => ({
          render: (width: number) =>
            moleculeWidgetLines(activeMolecule, width - 1, uiRef?.theme ?? theme).map((l: string) => ` ${l}`),
          invalidate: () => {
            if (!activeMolecule) return;
            forceChildren = true;
            const cwd = process.cwd();
            void refreshMolecule(cwd).then(
              () => refreshChildren(cwd).then(() => renderMolecule(), () => {}),
              () => {},
            );
          },
        }),
        { placement: "aboveEditor" },
      );
    } catch {
      /* ui may be unavailable in non-interactive runs — never fatal */
    }
  }

  // Single guarded interval for the extension's lifetime; `timersStarted` prevents
  // double-registration if session_start fires again. Every tick bails out when
  // the TUI is gone, and the promise chain swallows rejections so the timer never
  // throws. refreshChildren is chained before renderMolecule so a step change
  // renders its fresh subtree within the same tick.
  function startPolling(cwd: string) {
    if (timersStarted || pollTimer) return;
    timersStarted = true;
    pollTimer = setInterval(() => {
      if (!uiRef?.setWidget) return; // dormant outside interactive TUI
      void refreshMolecule(cwd)
        .then(() => refreshChildren(cwd))
        .then(() => renderMolecule(), () => {});
    }, 5000);
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    uiRef = ctx?.ui ?? null;
    const cwd = ctx?.cwd ?? process.cwd();
    startPolling(cwd);
    void refreshMolecule(cwd).then(
      () => renderMolecule(),
      () => {
        /* bd missing/broken -> widget just stays empty */
      },
    );
  });

  // a fresh turn always re-syncs both the current step and its children
  pi.on("agent_start", async (_event: any, ctx: any) => {
    const cwd = ctx?.cwd ?? process.cwd();
    void refreshMolecule(cwd)
      .then(() => refreshChildren(cwd))
      .then(() => renderMolecule(), () => {});
  });
}
