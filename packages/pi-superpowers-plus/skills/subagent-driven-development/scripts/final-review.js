// Final whole-branch review as a deterministic SubagentWorkflow (pi >=0.84).
// Invoked by the SDD controller during Final Review:
//   SubagentWorkflow({ scriptPath: "<skill>/scripts/final-review.js", args: {
//     packagePath, base, head, description, gateBeadId, dimensions? } })
// The script has no filesystem/bash — its agents do all reading. Read-only on
// beads: finders only beads_show the gate bead for Global Constraints. Only the
// return envelope persists (the resume journal is session-scoped).

export const meta = {
  name: 'sdd-final-review',
  description: 'Parallel dimension review of the whole-branch diff, adversarial verification of each finding, schema-validated findings',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

// Defensive: some hosts deliver `args` to the sandbox as a JSON string
// rather than the documented object (smoke-test discovery, pi-packages-1fjq).
const ARGS = (typeof args === 'string' ? JSON.parse(args) : args) ?? {}

const DIMENSIONS = ARGS.dimensions ?? ['correctness', 'security', 'performance', 'plan', 'maintainability']

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { enum: ['critical', 'important', 'minor'] },
          description: { type: 'string' },
        },
        required: ['file', 'severity', 'description'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['isReal', 'reason'],
}

const FOCUS = {
  correctness: 'Correctness: does the code do what it claims — logic errors, off-by-one, wrong branches, broken invariants, incorrect error paths, silent failure modes?',
  security: 'Security: injection, path traversal, authz gaps, unsafe deserialization, secrets committed, TOCTOU, any hardening regression?',
  performance: 'Performance: accidental quadratic behavior, unbounded loops, needless I/O or recomputation, N+1 patterns, memory growth?',
  plan: 'Plan/spec alignment: does the implementation match the plan and spec? Deviations justified improvements or problematic departures? Is all planned functionality present?',
  maintainability: 'Maintainability: separation of concerns, clear names, DRY without premature abstraction, dead code, test quality, accurate docs?',
}

const SEVERITY_RANK = { minor: 1, important: 2, critical: 3 }
const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()
const dedupeKey = (f) =>
  f.line
    ? f.file + ':' + f.line + ':' + f.severity + ':' + normalize(f.description)
    : f.file + ':' + f.severity + ':' + normalize(f.description)

function dedupe(all) {
  const map = new Map()
  for (const f of all) {
    const k = dedupeKey(f)
    const prev = map.get(k)
    if (!prev) {
      map.set(k, { ...f, dimensions: [f.dimension] })
    } else if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) {
      map.set(k, { ...f, dimensions: prev.dimensions.concat([f.dimension]) })
    } else {
      prev.dimensions.push(f.dimension)
    }
  }
  return Array.from(map.values())
}

const requirement = (dimension) => [
  'You are a Senior Code Reviewer. Review the completed work on',
  ARGS.base + '..' + ARGS.head,
  '',
  'Read the review package ONCE at:',
  ARGS.packagePath,
  '',
  'It contains the commit list, stat summary, and the full diff with context — it is your view of the change. Do not re-run git commands. Your review is READ-ONLY.',
  '',
  'What was implemented:',
  ARGS.description,
  '',
  'Read the plan Global Constraints (they are the attention lens): beads_show({ id: "' + ARGS.gateBeadId + '", full: true }).',
  '',
  'YOUR LENS — ' + dimension + ':',
  FOCUS[dimension],
  '',
  'Find REAL issues only, at the correct severity (critical/important/minor). Return the schema object; an empty findings array when clean.',
].join('\n')

const refutation = (f) => [
  'Adversarial verification. A reviewer flagged this finding about the change under review:',
  'file: ' + f.file + (f.line ? ':' + f.line : ''),
  'severity: ' + f.severity,
  'description: ' + f.description,
  '',
  'Try to REFUTE it: read the review package at ' + ARGS.packagePath + ' and check whether the finding actually holds against the diff. Default to refuted unless the finding clearly holds. Your reason must name the specific code it does or does not apply to.',
  '',
  'Return the schema object: isReal (false = refuted), reason (your judgment).',
].join('\n')

phase('Find')
const results = await parallel(DIMENSIONS.map((d) => () =>
  agent(requirement(d), { agentType: 'code-reviewer', label: 'find:' + d, phase: 'Find', schema: FINDINGS_SCHEMA })
    .then((r) => ({ dimension: d, r }))
))

const all = results
  .filter(Boolean)
  .flatMap(({ dimension, r }) =>
    r && Array.isArray(r.findings) ? r.findings.map((f) => ({ ...f, dimension })) : [],
  )
const deduped = dedupe(all)

if (deduped.length === 0) {
  return {
    base: ARGS.base, head: ARGS.head, dimensions: DIMENSIONS, findings: [],
    degraded: results.every((r) => r === null || (r && r.r === null)) ? 'all dimension finders failed' : null,
  }
}

phase('Verify')
const verdicts = await parallel(deduped.map((f) => () =>
  agent(refutation(f), { agentType: 'general-purpose', label: 'verify:' + (f.line ? f.file + ':' + f.line : f.file), phase: 'Verify', schema: VERDICT_SCHEMA })
))

const findings = deduped.map((f, i) => ({
  file: f.file,
  ...(f.line ? { line: f.line } : {}),
  severity: f.severity,
  dimensions: f.dimensions,
  description: f.description,
  verification: verdicts[i]
    ? { isReal: verdicts[i].isReal, reason: verdicts[i].reason }
    : { isReal: true, reason: 'unverified (refuter skipped)' },
}))

return { base: ARGS.base, head: ARGS.head, dimensions: DIMENSIONS, findings, degraded: null }
