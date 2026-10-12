import { describe, expect, it } from "vitest";
import { identityLines } from "../src/identity.js";

describe("identityLines", () => {
  it("prints the id alone for a record with no handle or alias", () => {
    // A nested child carries neither, by design (agent-manager.ts:508-520).
    expect(identityLines({ id: "child-1" })).toBe("Agent ID: child-1\n");
  });

  it("prints the handle a spawn actually assigned", () => {
    expect(identityLines({ id: "abc", handle: "explore" })).toBe("Agent ID: abc\nHandle: explore\n");
  });

  it("prefers the alias over the handle", () => {
    // `alias` comes from the caller's `name`, `handle` from the agent type. A
    // second dispatch under one name is suffixed (`-impl-2`), so the alias is
    // the more specific of the two.
    expect(identityLines({ id: "abc", handle: "explore", alias: "explore-2" })).toBe(
      "Agent ID: abc\nHandle: explore-2\n",
    );
  });

  it("prints an alias with no handle set", () => {
    expect(identityLines({ id: "abc", alias: "explore-2" })).toBe("Agent ID: abc\nHandle: explore-2\n");
  });
});
