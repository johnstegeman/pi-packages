import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import setupPhaseCommands from "./phase-commands.mjs";

/**
 * Phase-command input transforms: `/brainstorming`/`/brainstorm`, `/plan`, `/verify`,
 * `/review`, `/finish` rewrite to `/skill:<name>` before pi's skill expansion so the
 * hidden phase skills load on demand; `/execute` presents the SDD-vs-executing choice
 * in the editor and blocks (handled) so the user picks. Pure text rewriting — no state
 * tracking, no bead writes, no registerCommand.
 */
export default function (pi: ExtensionAPI) {
  setupPhaseCommands(pi);
}
