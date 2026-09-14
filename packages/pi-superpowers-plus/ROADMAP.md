# Roadmap

Forward-looking work for `pi-superpowers-plus`, now vendored as
`packages/pi-superpowers-plus/` in the [pi-packages monorepo](https://github.com/johnstegeman/pi-packages).
For shipped history see [CHANGELOG.md](./CHANGELOG.md).

## Tracking links

- **Questions/support:** https://github.com/johnstegeman/pi-packages/discussions
- **Bugs & feature requests:** https://github.com/johnstegeman/pi-packages/issues/new/choose
- **Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Tags

- **[user]** user-visible behavior / UX
- **[maintainer]** refactors, internals, tests, CI
- **[docs]** documentation
- **[infra]** packaging / release / build plumbing

## Current state

`pi-superpowers-plus` ships Superpowers workflow skills, 5 agent templates, and
its own pi extensions (`phase-commands`, `set-phase`, `beads-molecule-widget`,
`formula-seed`) plus the `superpowers-workflow` formula. It has no compiled output
and no `src/` tree. Tests are plain `node:*` scripts under `test/` (plus the
co-located SDD script tests), run with `npm test` alongside `biome check .`.

## Next

### Integration / smoke tests
**[maintainer]** Extension registration, widget lifecycle, and phase-command
transforms are covered by unit tests; add a near-real pi-instance smoke test for
the critical paths unit tests structurally can't reach.

### Documentation workflow skill
**[docs]** A skill for keeping package docs in lockstep with the shipped surface;
the tool-surface guard test is a first step.

### Skill consistency pass
**[maintainer]** Normalize wording, boundaries, and stop conditions across all skills.

## Future ideas

- **[user]** Decision log / session recap — a human-readable summary of workflow decisions.
- **[user]** Higher-level activity audit trail — what the workflow decided and why.
- **[user]** `/superpowers query "<question>"` — explain current workflow state from the audit trail (no LLM call).

## Maintenance rules

- If a roadmap item becomes real work, link it to a GitHub issue in the monorepo.
- When an item ships, move it to [CHANGELOG.md](./CHANGELOG.md) with the release version.
