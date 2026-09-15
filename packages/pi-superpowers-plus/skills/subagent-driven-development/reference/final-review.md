# Final review: workflow path, args, and findings audit

- **Workflow path** (preferred when `SubagentWorkflow` is present and the branch is large or broad — multi-file, many commits, security-sensitive, or deferred minors to triage): invoke the skill's final-review workflow:

      SubagentWorkflow({
        scriptPath: "<skill-scripts-dir>/final-review.js", // the dir containing this skill's scripts/ (e.g. packages/pi-superpowers-plus/skills/subagent-driven-development/scripts/)
        args: {
          packagePath: "<printed package path>",
          base: "<MERGE_BASE>",
          head: "<HEAD>",
          description: "<what was implemented — one paragraph from the After-All-Tasks summary>",
          gateBeadId: "<plan-approval-gate-bead-id>",
          findingsFile: "<sdd-workspace>/final-review-<run-id>.jsonl", // absolute path, git-ignored — keeps the run's return envelope compact
        },
      })

  It runs in the background — wait for the completion notification. Pass `findingsFile` (a FRESH absolute path to a JSONL under the git-ignored sdd workspace — the children append to it, so a stale file for the same range from an earlier run would otherwise merge into the new run) so the workflow persists its findings instead of returning them inline: the run's return value is then the compact envelope `{ findingsFile, count, degraded, dimStatus, refuted, persisted }` (`persisted` tells whether the writer child reported writing the file — the audit below is the real check), and the full per-finding payload is read from the JSONL file — find lines carry `kind: "find"` with the dimension on the line itself (`dimension: <DIM>`) and the schema-validated findings array (each finding item carries `file`, optional `line`, `severity`, `description` — the dimension does not ride per item); verify lines carry `kind: "verify"` with the copied fields `file`, `line`, `severity`, `description` plus the adversarial `verdict { isReal, reason }`. Join verify lines to findings by file/line/normalized-description — the same dedupe key the script uses. Findings with `isReal: false` are refuted — not open — unless the refutation's reason is contestable, in which case re-adjudicate it yourself (never silently drop). If the envelope reports `degraded` — set whenever any dimension finder fails (partial or total, e.g. `degraded: "N of M dimension finders failed"`) — or the run errors (or `findingsFile` lines are missing), fall back to the single-reviewer path. When `count === 0` no file is written for a clean run — accept `{ count: 0, degraded: null }` as clean, without file audit and without fallback (the audit applies only when `count > 0`). When `count > 0`, verify the audit trail before adjudicating: `node -e "const fs=require('fs');for(const l of fs.readFileSync(process.argv[1],'utf8').trim().split('\n'))JSON.parse(l);console.log('ok '+process.argv[1])" <findingsFile>` must print ok (every line valid JSON); if it fails, or the line count is less than `count`, treat the run as degraded and fall back to the single-reviewer path.
