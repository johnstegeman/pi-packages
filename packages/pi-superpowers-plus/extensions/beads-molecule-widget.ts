import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyMoleculeFrame,
  createChangeCoalescer,
  moleculeWidgetLines,
  nextRefreshArgs,
  parseMoleculeCurrent,
} from "./beads-molecule-widget.mjs";

type WidgetTheme = { fg?: (color: string, text: string) => string };
type UiApi = {
  setWidget(id: string, widget: unknown, opts?: unknown): void;
  theme?: WidgetTheme;
};
type SessionContext = { ui?: UiApi; cwd?: string };

export default function (pi: ExtensionAPI) {
  let ui: UiApi | null = null;
  let activeMolecule: ReturnType<typeof parseMoleculeCurrent> | null = null;
  // once a molecule is seen, remember its id so refreshes re-query by id — the
  // no-id inference call drops out (returns []) when no step is in_progress,
  // which used to freeze the widget on a stale frame after the implement step
  // closed.
  let lockedMoleculeId: string | null = null;

  // ---- event-driven refresh: fires on every beads:changed, coalesced ----
  let coalescer: ReturnType<typeof createChangeCoalescer> | null = null;
  let lastCwd = process.cwd();

  function doRefresh() {
    const cwd = lastCwd;
    void refreshMolecule(cwd).then(
      () => renderMolecule(),
      () => {},
    );
  }

  async function refreshMolecule(cwd: string): Promise<void> {
    const queriedById = lockedMoleculeId !== null;
    const args = nextRefreshArgs(lockedMoleculeId);
    const r = await pi.exec("bd", args, {
      cwd,
      timeout: 5000,
    });
    if (r?.code !== 0) {
      // only clear on a clean "no active molecule" signal, never on a transient
      // failure — an unreachable bd binary should not blank a widget that was
      // showing real progress a moment ago.
      if (r && /no active molecule/i.test(r.stderr ?? "")) activeMolecule = null;
      return;
    }
    const parsed = parseMoleculeCurrent(r.stdout);
    const next = applyMoleculeFrame(activeMolecule, lockedMoleculeId, parsed, queriedById);
    activeMolecule = next.activeMolecule;
    lockedMoleculeId = next.lockedMoleculeId;
  }

  function renderMolecule() {
    try {
      if (!ui?.setWidget) return;
      if (!activeMolecule) {
        ui.setWidget("beads-mol", undefined);
        return;
      }
      ui.setWidget(
        "beads-mol",
        (_tui: unknown, theme: WidgetTheme | undefined) => ({
          render: (width: number) =>
            moleculeWidgetLines(activeMolecule, width - 1, ui?.theme ?? theme).map((l: string) => ` ${l}`),
        }),
        { placement: "aboveEditor" },
      );
    } catch {
      /* ui may be unavailable in non-interactive runs — never fatal */
    }
  }

  pi.on("session_start", (_event: unknown, ctx: SessionContext) => {
    ui = ctx?.ui ?? null;
    const cwd = ctx?.cwd ?? process.cwd();
    lastCwd = cwd;
    if (!coalescer) {
      const c = createChangeCoalescer(doRefresh, 10000);
      coalescer = c;
      pi.events.on("beads:changed", () => c.trigger());
    }
    void refreshMolecule(cwd).then(
      () => renderMolecule(),
      () => {},
    );
  });

  // a fresh turn always re-syncs the current molecule state
  pi.on("agent_start", (_event: unknown, ctx: SessionContext) => {
    const cwd = ctx?.cwd ?? process.cwd();
    lastCwd = cwd;
    void refreshMolecule(cwd).then(
      () => renderMolecule(),
      () => {},
    );
  });
}
