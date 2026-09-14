import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPhaseLifecycle } from "./set-phase.mjs";

export default function (pi: ExtensionAPI) {
  createPhaseLifecycle({
    emit: (channel, data) => pi.events.emit(channel, data),
    on: (event, handler) => pi.on(event, handler),
  });

  pi.registerTool({
    name: "set_phase",
    label: "Set Phase",
    description:
      'Emit the current Superpowers workflow phase on the superpowers:phase event bus channel for observability (e.g. cost tracking by phase). Canonical phases: `brainstorming` (brainstorming and planning) and `development` (implementation, code review, final review, finishing); pass `""` to clear. Only the Superpowers skills should call this — do not use it for ordinary work.',
    parameters: Type.Object({
      phase: Type.String({
        description:
          'The workflow phase: `brainstorming` or `development` (or `""` to clear). Superpowers skills pass only these; other strings are accepted for future extension.',
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
