// Gated fix round as a deterministic SubagentWorkflow (pi >=0.84).
// Invoked by the SDD controller when a task's fix loop has a covering-test
// command (from the implementer's report, or the package's npm test):
//   SubagentWorkflow({ scriptPath: "<skill>/scripts/fix-loop.js", args: {
//     taskBeadId, reportFilePath, findings, gate, fixBase, head,
//     gateBeadId, packagePath, reviewPackage } })
// One item (= one fix round) through two pipeline stages: gated fix, then
// scoped re-review. A failed stage 1 (gate did not pass after one resume)
// drops the item, so re-review never runs on an unproven fix.
// Read-only on beads; only the return envelope persists (the resume journal
// is session-scoped).

export const meta = {
  name: 'sdd-fix-loop',
  description: 'Gated fix round: covering-test command as a hard gate, then scoped re-review',
  phases: [{ title: 'Fix' }, { title: 'Re-review' }],
}

// Defensive: some hosts deliver `args` to the sandbox as a JSON string
// rather than the documented object (smoke-test discovery, pi-packages-1fjq;
// same guard as final-review.js).
let parsedArgs
try {
  parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
} catch {
  // Malformed args string degrades to an empty object, never a fatal throw.
  parsedArgs = null
}
const ARGS = parsedArgs ?? {}

// A round without a task or a gate is a caller bug, not a fix failure: flag
// it so the controller falls back to the prose path instead of adjudicating.
if (!ARGS.taskBeadId || !ARGS.gate) {
  return { passed: false, reason: 'bad-args', gateOutput: 'fix-loop.js invoked without taskBeadId or gate' }
}

const gateCommand = ARGS.gate

const fixPrompt = [
  'You are fixing review findings. The covering-test command below is your hard exit criterion — do not report done until it passes.',
  '',
  'Task bead (the exact task text): beads_show({ id: "' + ARGS.taskBeadId + '", full: true }).',
  'Report file (append your fix report at the end — what you changed, the tests you ran, the output): ' + ARGS.reportFilePath,
  'Global Constraints (attention lens): beads_show({ id: "' + ARGS.gateBeadId + '", full: true }).',
  '',
  'Open findings to fix:',
  String(ARGS.findings ?? ''),
  '',
  'Fix every open finding. Re-run the covering tests yourself before finishing. Do not report done until this command passes:',
  '',
  '  ' + gateCommand,
  '',
  'Your final message is the short contract: what you changed, the command output tail, and the report file path.',
].join('\n')

phase('Fix')

async function fixStage() {
  // The gate runs after the agent finishes: a non-zero exit fails the agent
  // and folds the command output into its error, so `fixed` is null exactly
  // when the suite did not pass — no model judges prose evidence.
  let fixed = await agent(fixPrompt, { label: 'fix', gate: gateCommand, phase: 'Fix' })

  if (fixed === null) {
    log(gateCommand + ' failed — handing the output back to the same child')

    // Resume, not a fresh spawn: the child still has the task, the code, and
    // its own choices. Ungated, because gate cannot combine with resume.
    fixed = await agent(
      '`' + gateCommand + '` is still failing. Read the failure above, fix the cause, and stop.',
      { label: 'fix', resume: 'fix', phase: 'Fix' },
    )

    // The resume could not carry the gate, so verify separately with a fresh
    // gated call in the same tree. This is the entire retry budget.
    const verified = await agent(
      'Run `' + gateCommand + '` and report the result. Change nothing.',
      { label: 'verify', gate: gateCommand, effort: 'low', phase: 'Fix' },
    )
    if (verified === null) {
      // A throw drops this pipeline item; the round resolves to null.
      throw new Error('gate still failing after one resume: ' + gateCommand)
    }
  }
  return { summary: fixed }
}

const reReviewPrompt = [
  "You are re-reviewing one task's fix round. A previous review produced findings; an implementer has attempted to fix them. Verdict each finding and inspect the fix diff — nothing else.",
  '',
  'Task bead (the exact task text): beads_show({ id: "' + ARGS.taskBeadId + '", full: true }).',
  'Report file (fix report appended at the end): ' + ARGS.reportFilePath,
  'Global Constraints (attention lens): beads_show({ id: "' + ARGS.gateBeadId + '", full: true }).',
  '',
  '**Fix base:** ' + ARGS.fixBase + ' (the head the previous review saw)',
  '**Head:** ' + ARGS.head,
  '',
  'Build the scoped review package yourself:',
  '  ' + ARGS.reviewPackage + ' ' + ARGS.taskBeadId + ' ' + ARGS.fixBase + ' ' + ARGS.head,
  'Read the printed diff file once. Do not re-run git commands beyond that script. Your review is READ-ONLY: do not mutate the working tree, the index, HEAD, or branch state.',
  '',
  'Findings under verification:',
  String(ARGS.findings ?? ''),
  '',
  'Verdict every finding in order: [finding one-liner] — ADDRESSED | NOT ADDRESSED, with file:line evidence. "Attempted" is not addressed: the specific defect must no longer exist.',
  'Inspect the fix diff for new problems the fix itself introduced, with severity (Critical/Important/Minor) and file:line. "None" if clean.',
  'Issues entirely outside the fix diff: list under Out-of-Scope Observations — non-blocking, do not extend the loop.',
  'Tests: the implementer re-ran the covering tests and the gate command passed — verify the claims against the diff. Do not re-run the suite unless reading the code raises a specific doubt.',
  '',
  "Your final message is the report itself: begin directly with the first finding's verdict — no preamble. End with: **Fix round:** [All findings addressed, no new Critical/Important breakage | Findings remain open] — list the open ones.",
].join('\n')

async function reReviewStage(prev) {
  phase('Re-review')
  const reReview = await agent(reReviewPrompt, { agentType: 'code-reviewer', label: 're-review', phase: 'Re-review' })
  return { summary: prev.summary, reReview }
}

// One item = one fix round. A gate failure in stage 1 drops the item to null,
// so re-review never runs on an unproven fix.
const round = (await pipeline([{}], fixStage, reReviewStage))[0]
if (!round) {
  return { passed: false, reason: 'gate-failed', gateOutput: 'gate non-zero after one resume (' + gateCommand + ')', agentSummary: null }
}
return { passed: true, summary: round.summary, reReview: round.reReview }
