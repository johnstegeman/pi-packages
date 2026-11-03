# Quick Reference

| Option | Merge | Push | Keep Worktree | Cleanup Branch |
|--------|-------|------|---------------|----------------|
| 1. Merge locally | yes | - | - | yes |
| 2. Create PR | - | yes | yes | - |
| 3. Keep as-is | - | - | yes | - |
| Discard (explicit request only) | - | - | - | yes (force) |

PR shape (asked when a PR option is chosen): **all commits** (push as-is) or
**squashed** — collapse to one commit before pushing (`git reset --soft` to the
merge base + a single composed message, shown to the user first); a previously
pushed squashed branch needs `--force-with-lease`. Never squash an already-open PR.
