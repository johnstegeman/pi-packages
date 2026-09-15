import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMoleculeWidgetController } from "./beads-molecule-widget-controller.mjs";

type WidgetTheme = { fg?: (color: string, text: string) => string };
type UiApi = {
  setWidget(id: string, widget: unknown, opts?: unknown): void;
  theme?: WidgetTheme;
};
type SessionContext = { ui?: UiApi; cwd?: string };

export default function (pi: ExtensionAPI) {
  const controller = createMoleculeWidgetController({
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    // The widget is event-driven: it queries `bd` only when superpowers or beads
    // actually does something, never on pi startup. `superpowers:phase` fires
    // from set_phase when a superpowers workflow begins (an empty phase is the
    // session-boundary clear and must not trigger a query).
    subscribeChanges: (onChange) => {
      const offBeads = pi.events.on("beads:changed", () => onChange());
      const offPhase = pi.events.on("superpowers:phase", (data) => {
        const phase = (data as { phase?: unknown } | null)?.phase;
        if (typeof phase === "string" && phase !== "") onChange();
      });
      return () => {
        offBeads();
        offPhase();
      };
    },
    warn: (...args) => console.warn(...args),
  });

  pi.on("session_start", (_event: unknown, ctx: SessionContext) => {
    // Bind without a startup query: beads may not be initialized here, and the
    // widget has nothing to show until superpowers/beads emits an event. (The
    // per-turn `agent_start` refresh below is deliberately left in place.)
    controller.bindSession({
      ui: ctx?.ui ?? null,
      cwd: ctx?.cwd ?? process.cwd(),
      initialRefresh: false,
    });
  });

  pi.on("agent_start", (_event: unknown, ctx: SessionContext) => {
    // Per-turn resync: this is NOT startup, so it must keep refreshing. It is the
    // backstop that surfaces out-of-band mutations (raw `bd`, another session) that
    // never emit `beads:changed`.
    controller.setCwd(ctx?.cwd ?? process.cwd());
  });

  pi.on("session_shutdown", () => {
    controller.unbindSession();
  });
}
