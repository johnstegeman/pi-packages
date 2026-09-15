# Task review: inputs, constraint lens, and pre-judging

- **Reviewer inputs:** the task reviewer gets three paths — the same task
  bead id, the report file, and the review package — plus the gate bead
  id holding the plan's canonical Global Constraints.
- The Global Constraints block is the reviewer's attention lens. Read it
  once from the plan-approval gate bead's description
  (`beads_show({ id: "<plan-approval-gate-bead-id>", full: true })`, populated by `writing-plans`) and pass that
  gate id to the reviewer dispatch — the reviewer template carries the read instruction itself,
  so the constraints are byte-identical across every task review. The reviewer's template
  already carries the process rules (YAGNI, test hygiene, review method) — the constraints are
  for what THIS project's spec demands.
- Do not add open-ended directives like "check all uses" or "run race tests
  if useful" without a concrete, task-specific reason
- Do not ask a reviewer to re-run tests the implementer already ran on the
  same code — the implementer's report carries the test evidence
- Do not pre-judge findings for the reviewer — never instruct a reviewer to
  ignore or not flag a specific issue. If you believe a finding would be a
  false positive, let the reviewer raise it and adjudicate it in the review
  loop. If the prompt you are writing contains "do not flag," "don't treat X
  as a defect," "at most Minor," or "the plan chose" — stop: you are
  pre-judging, usually to spare yourself a review loop.
The task reviewer may report "⚠️ Cannot verify from diff" items — requirements
that live in unchanged code or span tasks. These do not block the rest of the
review, but you must resolve each one yourself before marking the task
complete: you hold the plan and cross-task context the reviewer
lacks. If you confirm an item is a real gap, treat it as a failed spec
review — it enters the fix loop with the other findings.
