/**
 * Activate pi's `codemode` tool for every session.
 *
 * pi registers `codemode` inactive: it is turned on only by an MCP server with
 * codemode exposure, or by `defaultTools`/`--tools`. pi-packages ships tools with
 * `exposure: "codemode"`/`"deferred"`, which are reachable ONLY through the
 * codemode tool, so this extension turns it on without requiring a settings edit.
 *
 * Design: docs/superpowers/specs/2026-09-30-codemode-adoption-design.md
 */
const CODEMODE = "codemode";

export default function codemodeBootstrap(pi: any): void {
  const activate = (): void => {
    try {
      const registered: string[] = (pi.getAllTools?.() ?? []).map((t: any) => t.name);
      if (!registered.includes(CODEMODE)) return; // host disabled it (-builtin:codemode)
      const active: string[] = pi.getActiveTools?.() ?? [];
      if (active.includes(CODEMODE)) return; // already on
      pi.setActiveTools?.([...active, CODEMODE]);
    } catch {
      // getAllTools/setActiveTools throw only in a host that loads extension
      // definitions without ever binding a session — standalone
      // `discoverAndLoadExtensions`, for instance; the throwing stubs exist only
      // until `core.bindCore` runs. A bound print-mode or SDK session exposes
      // both normally. Not being able to check is not a reason to fail.
    }
  };
  pi.on?.("session_start", activate);
}
