# Redevelopment inventory — the four-repo split, anchored on pi-rex

Input material for brainstorming the redevelopment of this monorepo's extensions
into **four repos** against a hard-required **pi + beads + rex** stack (no fallbacks
when a tool isn't installed):

1. **pi-rex** — https://github.com/johnstegeman/pi-rex (play on Pyrex) — superpowers,
   beads, subagents, codemode-bootstrap. The tightly-coupled cluster; **fully
   inventoried here** (files 03, 05, 06, 07 + 00/01/02).
2. **pi-carte** — https://github.com/johnstegeman/pi-carte — bifrost + langfuse (à la
   carte: the menu is the model catalog, routing is ordering, the trace is the
   carte). **Fully inventoried** — file 08 is its primary input.
3. **pi-garnish** — https://github.com/johnstegeman/pi-garnish — ayu + statusline
   (with jj support). **Fully inventoried** — file 09 is its primary input.
4. **pi-whetstone** — https://github.com/johnstegeman/pi-whetstone — hashline-edit
   (sharpen your most important tools). **Fully inventoried** (file 04).

The topology, per-repo notes, and cross-repo seams (the `superpowers:phase` event
contract) are in 00-context-and-goals.md §The mission.

## Files

| File | Contents |
|---|---|
| [00-context-and-goals.md](00-context-and-goals.md) | The four-repo topology (pi-rex + three siblings), constraints, current environment, and the open questions to settle before spec writing |
| [01-repo-infrastructure.md](01-repo-infrastructure.md) | Root-level features: packaging/manifest, package gate, dep-mirror gate, CI, toolchain pinning, docs layout, install story |
| [02-vcs-considerations.md](02-vcs-considerations.md) | worktrunk vs jj findings (from spike bead `pi-packages-tutyu`), git-coupling inventory, the VERIFIED worktrunk+jj hybrid workflow (option 5, live-probe findings), and the `ginit` from-scratch bootstrap recipe (gclone analog) |
| [03-codemode-bootstrap.md](03-codemode-bootstrap.md) | Feature inventory: codemode-bootstrap |
| [04-hashline-edit.md](04-hashline-edit.md) | Feature inventory: hashline-edit |
| [05-pi-beads.md](05-pi-beads.md) | Feature inventory: pi-beads (beads_* tools, skills, cost tracking) |
| [06-pi-subagents.md](06-pi-subagents.md) | Feature inventory: pi-subagents (dispatch, workflows, widgets, Rex pane design) |
| [07-pi-superpowers-plus.md](07-pi-superpowers-plus.md) | Feature inventory: pi-superpowers-plus (skills, set_phase, molecule widget, formula seed, agent templates) |
| [08-pi-carte.md](08-pi-carte.md) | Feature inventory: pi-carte (bifrost provider + langfuse tracing, the superpowers:phase contract, preserve-exactly checklist) |
| [09-pi-garnish.md](09-pi-garnish.md) | Feature inventory: pi-garnish (ayu themes + statusline, full jj gap analysis and dual-mode design) |

## How to use

Each inventory file is a granular, numbered capability list with the semantics,
edge cases, and deliberate design decisions that the current implementation pins
down (via code and tests). Feed one file per brainstorming session; each numbered
capability becomes spec/plan material. Items marked **[decide]** need a user decision
before they can be specced; they are collected in 00-context-and-goals.md.

These files describe **what exists today**, not what the new repo should do —
subtractions (fallback removal), additions, and redesigns are brainstorming output,
with the **[decide]** items and the "Fallbacks that exist today" sections as the
primary input for that.
