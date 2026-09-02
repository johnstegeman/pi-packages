import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { moleculeWidgetLines, parseMoleculeCurrent } from "./beads-molecule-widget.mjs";

export default function (pi: ExtensionAPI) {
  let uiRef: any = null;
  let activeMolecule: ReturnType<typeof parseMoleculeCurrent> | null = null;

  // No timers, ever: refreshed at session_start and every agent_start. Skills run bare
  // `bd cook`/`bd mol pour`/`bd dep add`/`bd create --parent` outside any tool call this
  // extension could hook, so a per-turn safety-net read is required, not optional.
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
    if (parsed) activeMolecule = parsed;
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
          invalidate: () => {},
        }),
        { placement: "aboveEditor" },
      );
    } catch {
      /* ui may be unavailable in non-interactive runs — never fatal */
    }
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    uiRef = ctx?.ui ?? null;
    const cwd = ctx?.cwd ?? process.cwd();
    void refreshMolecule(cwd).then(
      () => renderMolecule(),
      () => {
        /* bd missing/broken -> widget just stays empty */
      },
    );
  });

  pi.on("agent_start", async (_event: any, ctx: any) => {
    const cwd = ctx?.cwd ?? process.cwd();
    void refreshMolecule(cwd).then(
      () => renderMolecule(),
      () => {},
    );
  });
}
