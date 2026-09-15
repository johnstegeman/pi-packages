# Brainstorming Anti-Patterns

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Anti-Pattern: Rushing the Checklist in One Turn

After the user answers a question, it's tempting to treat that as "enough" and fast-forward through proposing approaches, presenting a design, writing the doc, and handing off to `writing-plans` — all without another real exchange. This produces designs nobody actually reviewed. Each of "ask more questions," "propose approaches," and "present design sections" is its own turn (or several); only advance when the user's actual words justify it, never because the checklist item "seems small."

## Anti-Pattern: "Let Me Just Peek At The Repo First"

Exploration ("I'll just do a quick `ls` / read a few files / check recent commits first")
is Step 1, and Step 1 must not begin until Step 0's widget is on screen. What looks like
harmless context-gathering is the exact mechanism by which the mandatory tracking setup
gets silently deferred — once you start reading the project it feels productive and the
pour never happens. If you are about to touch files or run git commands before
`beads_mol_pour` + `beads_mol_current` have run and the widget is visible, stop and pour
first. This holds even when the work is a follow-up on an existing epic.
