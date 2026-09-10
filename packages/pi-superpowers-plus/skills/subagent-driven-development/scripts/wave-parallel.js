// Wave-parallel implementation as a deterministic SubagentWorkflow (pi >=0.84).
// Invoked by the SDD controller for a wave of DISJOINT-file tasks from the
// beads ready frontier:
//   SubagentWorkflow({ scriptPath: "<skill>/scripts/wave-parallel.js", args: {
//     wave: [{ taskBeadId, gate?, files: [...] }], base, reportDir,
//     gateBeadId, reviewPackage } })
// One item = one task, through pipeline stages [implement, review]. The review
// stage exists only for done/done_with_concerns items (anything else
// short-circuits back to the controller). Implementers work the shared plan
// branch; the review stage builds each task's package file-scoped so
// interleaved commits cannot contaminate the review.
// Read-only on beads; only the return envelope persists (the resume journal
// is session-scoped).

export const meta = {
  name: 'sdd-wave-parallel',
  description: 'Wave-parallel implementation: concurrent disjoint-file implementations gated by declared covering tests, schema-validated per-task reviews',
  phases: [{ title: 'Implement' }, { title: 'Review' }],
}

// Defensive: some hosts deliver `args` to the sandbox as a JSON string
// rather than the documented object (same guard as final-review.js).
let parsedArgs
try {
  parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
} catch {
  parsedArgs = null
}
const ARGS = parsedArgs ?? {}

const WAVE = Array.isArray(ARGS.wave) ? ARGS.wave : []

const IMPLEMENT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['done', 'done_with_concerns', 'needs_context', 'blocked'] },
    commits: { type: 'string' },
    testSummary: { type: 'string' },
    coveringTestCommand: { type: 'string' },
    concerns: { type: 'string' },
    reportFile: { type: 'string' },
  },
  required: ['status', 'reportFile'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    specCompliant: { type: 'boolean' },
    cannotVerify: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { enum: ['critical', 'important', 'minor'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          description: { type: 'string' },
        },
        required: ['severity', 'file', 'description'],
      },
    },
    assessment: { type: 'string' },
  },
  required: ['specCompliant', 'issues', 'assessment'],
}

const implementPrompt = (item) => [
  'You are implementing Task N. The covering-test command below is your hard exit criterion — do not report done until it passes (a non-zero exit fails you).',
  '',
  'Task bead (the exact task text): beads_show({ id: "' + item.taskBeadId + '", full: true }).',
  'Report file (write your full report there; return the path): ' + (ARGS.reportDir ?? '.') + '/' + item.taskBeadId + '-report.md',
  'Global Constraints (attention lens): beads_show({ id: "' + ARGS.gateBeadId + '", full: true }).',
  '',
  'Work on the SHARED branch. Commit exactly your own files (git add <your files>, one commit at the end); retry once after ~2s if a commit fails with an index.lock error. Never merge, rebase, or push.',
  ...(item.gate
    ? ['Covering-test command (must pass before you report done):', '', '  ' + item.gate]
    : ['There is no declared gate; report the covering tests you ran with their output.']),
  '',
  'Return the IMPLEMENT_RESULT schema object: status (done | done_with_concerns | needs_context | blocked), commits, testSummary, coveringTestCommand, concerns, reportFile.',
].join('\n')

const reviewPrompt = (item) => [
  "You are reviewing one task's wave implementation: spec compliance, then code quality. This is a task-scoped gate, not a merge review.",
  '',
  'Task bead (the exact task text): beads_show({ id: "' + item.taskBeadId + '", full: true }).',
  'Global Constraints (attention lens): beads_show({ id: "' + ARGS.gateBeadId + '", full: true }).',
  '',
  'Build the scoped review package yourself (resolve HEAD yourself):',
  '  ' + ARGS.reviewPackage + ' ' + item.taskBeadId + ' ' + ARGS.base + ' $(git rev-parse HEAD) -- ' + (item.files ?? []).join(' '),
  "Read the printed diff file once — it is scoped to this task's files. Do not re-run git commands beyond building the package. Your review is READ-ONLY: do not mutate the working tree, the index, HEAD, or branch state.",
  '',
  "Read the implementer's report: " + (ARGS.reportDir ?? '.') + '/' + item.taskBeadId + '-report.md',
  '',
  'Verdict spec compliance (missing/extra/misunderstood). Judge code quality (separation of concerns, error handling, DRY, edge cases, tests). Cite file:line for every issue. Requirements you cannot verify from the scoped diff: list under cannotVerify.',
  '',
  'Severity calibration: Critical = must fix; Important = cannot be trusted until fixed; Minor = polish.',
  '',
  'Return the REVIEW schema: specCompliant, cannotVerify, issues [{severity, file, line?, description}], assessment.',
].join('\n')

phase('Implement')

async function implementStage(item) {
  const result = await agent(implementPrompt(item), {
    label: 'implement:' + item.taskBeadId,
    phase: 'Implement',
    agentType: 'implementer',
    schema: IMPLEMENT_RESULT_SCHEMA,
    ...(item.gate ? { gate: item.gate } : {}),
  })
  if (result === null) {
    // Gate non-zero / child crash: the child was failed after writing its
    // report. The controller routes this to the fix loop with the declared
    // gate (or the prose path); nothing is silently dropped.
    return { status: item.gate ? 'gate-failed' : 'failed', reportFile: (ARGS.reportDir ?? '.') + '/' + item.taskBeadId + '-report.md' }
  }
  return result
}

async function reviewStage(prev, item) {
  if (prev.status !== 'done' && prev.status !== 'done_with_concerns') {
    return { ...prev, skipped: true, reason: prev.status }
  }
  phase('Review')
  const spec = await agent(reviewPrompt(item), {
    label: 'review:' + item.taskBeadId,
    phase: 'Review',
    agentType: 'task-reviewer',
    schema: REVIEW_SCHEMA,
  })
  if (spec === null) {
    return { ...prev, status: 'review-failed', skipped: true, reason: 'reviewer returned null' }
  }
  return { ...prev, spec }
}

const results = await pipeline(WAVE, implementStage, reviewStage)

// One entry per wave item; a dropped item (stage threw) degrades to failed.
const wave = results.map((r, i) => ({
  taskBeadId: WAVE[i]?.taskBeadId ?? 'unknown',
  ...(r ?? { status: 'failed', skipped: true, reason: 'pipeline item dropped' }),
}))

const degraded = wave.some((w) => w.status !== 'done' && w.status !== 'done_with_concerns')
  ? wave.filter((w) => w.status !== 'done' && w.status !== 'done_with_concerns').map((w) => w.taskBeadId + ':' + w.status).join(', ')
  : null

return { wave, degraded }
