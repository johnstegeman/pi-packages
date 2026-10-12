// LOCAL PATCH (pi-packages) — see docs/pi-subagents-local-patch.md (Divergence 9).
/**
 * The two identity lines a dispatch result carries.
 *
 * The id is the durable resume key. The handle is what the spawn actually
 * assigned — a second dispatch under the same `name` is silently suffixed
 * (`task-…-impl-2`), so the canonical name the caller asked for is only a
 * derivation and this is the authority. A record with neither (a nested child)
 * gets the id line alone.
 *
 * Lives here rather than inside index.ts because both entry points need it: the
 * top-level tools, and the nested delegation tools, which cannot import from
 * index.ts (that is the extension entry point). Same reason status-note.ts
 * exists. The Divergence 9 section its marker names records this move.
 */
export function identityLines(record: { id: string; alias?: string; handle?: string }): string {
  const handle = record.alias ?? record.handle;
  return `Agent ID: ${record.id}\n` + (handle ? `Handle: ${handle}\n` : "");
}
