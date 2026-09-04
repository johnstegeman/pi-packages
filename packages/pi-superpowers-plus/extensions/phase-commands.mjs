/**
 * Phase-command input transforms for the superpowers workflow.
 * Plain JS (no TS) so it's directly runnable/testable by node.
 *
 * Rewrites phase-entry commands (`/brainstorming`, `/plan`, ...) to
 * `/skill:<name>` before pi's skill expansion, so the hidden phase skills load
 * on demand. `/execute` presents the SDD-vs-executing choice in the editor and
 * blocks (handled) so the user picks. Pure text rewriting — no state tracking,
 * no bead writes, no registerCommand.
 */

const PHASE_SKILL_MAP = {
  "/brainstorming": "/skill:brainstorming",
  "/brainstorm": "/skill:brainstorming",
  "/plan": "/skill:writing-plans",
  "/verify": "/skill:verification-before-completion",
  "/review": "/skill:requesting-code-review",
  "/finish": "/skill:finishing-a-development-branch",
};

const EXECUTE_CHOICE =
  "Implementation phase. Two execution options:\n\n" +
  "1. /skill:subagent-driven-development (recommended, same session)\n" +
  "2. /skill:executing-plans (parallel session, batched)\n\n" +
  "Type the /skill: command for your chosen approach.";

export default function setupPhaseCommands(pi) {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const trimmed = (event.text ?? "").trim();
    const first = trimmed.split(/\s+/, 1)[0];

    if (PHASE_SKILL_MAP[first]) {
      const rest = trimmed.slice(first.length).trim();
      return { action: "transform", text: rest ? `${PHASE_SKILL_MAP[first]} ${rest}` : PHASE_SKILL_MAP[first] };
    }

    if (first === "/execute") {
      if (ctx?.hasUI) {
        ctx.ui.setEditorText(EXECUTE_CHOICE);
        ctx.ui.notify("Stage set to execute. Pick an execution approach.", "info");
      }
      return { action: "handled" };
    }

    return { action: "continue" };
  });
}
