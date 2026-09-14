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
    subscribeChanges: (onChange) => pi.events.on("beads:changed", () => onChange()),
    warn: (...args) => console.warn(...args),
  });

  pi.on("session_start", (_event: unknown, ctx: SessionContext) => {
    controller.bindSession({ ui: ctx?.ui ?? null, cwd: ctx?.cwd ?? process.cwd() });
  });

  pi.on("agent_start", (_event: unknown, ctx: SessionContext) => {
    controller.setCwd(ctx?.cwd ?? process.cwd());
  });

  pi.on("session_shutdown", () => {
    controller.unbindSession();
  });
}
