# Pi Tool Prerequisites

Skills speak in actions ("dispatch a subagent", "create a task", "read a file"). On Pi these resolve to tools provided by two companion packages — **installed separately**, not bundled with this package.

## Required packages

```bash
pi install npm:@tintinweb/pi-subagents
pi install <forked-pi-beads-package>   # fork of @abix5/pi-beads with ephemeral support
```

| Action skills request | Package | Tool |
| --- | --- | --- |
| Dispatch a subagent (`Agent({ subagent_type, prompt, description, ... })`) | [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) | `Agent`, `get_subagent_result`, `steer_subagent` |
| Task tracking (`beads_create`, `beads_update`, `beads_close`, `beads_dep`) | forked [`pi-beads`](https://github.com/abix5/pi-beads) (requires the fork's `ephemeral` support — upstream v0.2.2 lacks it) | `beads_ready`, `beads_list`, `beads_show`, `beads_create`, `beads_update`, `beads_close`, `beads_dep`, `beads_undep`, `beads_comment` |

There is **no fallback** if these packages aren't installed — skills reference the tools directly. For each tool's full parameter schema, see the package's own README (linked above); skills show the concrete call shapes you'll use day to day.

- **Pass `ephemeral: true` to `beads_create` for wisps** (session phase bookkeeping — excluded from sync, purged via `bd purge` when closed); omit it for persistent issues (durable plan-step work).
- **Repo routing:** omit `repo` on `beads_create` to target the session cwd's repo; from an umbrella root, pass the owning repo explicitly (`repo` is required there). Skills never hardcode a repo name.
- **Structural workflow:** brainstorm → design → plan → implement → verify → finish is
  modeled as a beads molecule poured from the bundled `superpowers-workflow` formula
  (`bd cook`/`bd mol pour`), not tracked via ad hoc wisps. Skills advance it with bare
  `bd` calls (`bd update --claim`, `bd close`, `bd gate resolve`, `bd ready --mol`) —
  see `docs/superpowers/specs/2026-09-02-beads-as-persistence-layer-design.md` for the
  full step graph.
- `pi-beads` registers its own `beads` skill — see it for the full tool reference rather than re-documenting the API here.

## Skill prompt `location` attribute

When pi loads a skill, it wraps the SKILL.md content in a prompt that includes a `location` attribute pointing at the skill's install path (e.g. `~/.pi/agent/git/.../pi-superpowers-plus/skills/<name>/SKILL.md`). This path exists **only** so you can resolve relative file references inside the skill (e.g. `references/foo.md`). It is **not** a working directory. Never `cd` there, never run `git log` or `ls` there, and never treat it as the user's project. The user's project is their current working directory — always work there.
