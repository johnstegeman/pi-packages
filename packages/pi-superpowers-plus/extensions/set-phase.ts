import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "set_phase",
    label: "Set Phase",
    description:
      "Emit the current Superpowers workflow phase on the superpowers:phase event bus channel for observability (e.g. cost tracking by phase). Pass `brainstorming` during brainstorming or planning, `development` during implementation or code review. Only the Superpowers skills should call this — do not use it for ordinary work.",
    parameters: Type.Object({
      phase: Type.String({
        description:
          "The workflow phase. Superpowers skills pass `brainstorming` or `development`. Accepts any string for future extension.",
      }),
    }),
    async execute(_toolCallId, params) {
      pi.events.emit("superpowers:phase", { phase: params.phase });
      // Minimal return so the model's own narration stays uninterrupted.
      return {
        content: [{ type: "text", text: "" }],
        details: {},
      };
    },
  });
}
