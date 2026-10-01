/**
 * Real extension fixture for the nested (codemode script) scope guard.
 *
 * Registers two `deferred`-exposure tools. A deferred tool is never activated on
 * registration, yet pi's `_getCallableTools()` hands it to codemode scripts
 * REGARDLESS of the active set — so an `ext:` narrowing, which can only bound
 * the ACTIVE set, does not bound what a script may call. The scope guard has to
 * veto `probe_denied` at call time via a `tool_call` handler instead.
 *
 * `probe_allowed` is the in-scope control: the narrowing selects it, so a script
 * calling it must still succeed (the guard must not become a blanket block).
 * See ext-alpha.mjs for the conventions.
 */
import { Type } from "@sinclair/typebox";

export default function (pi) {
  for (const name of ["probe_allowed", "probe_denied"]) {
    pi.registerTool({
      name,
      label: name,
      description: `${name} (deferred exposure, e2e fixture).`,
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        return { content: [{ type: "text", text: `${name} ran` }] };
      },
    });
  }
}
