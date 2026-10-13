// The ONE parser for the small TOML subset `superpowers-workflow.formula.toml` uses. Three
// readers need it — the widget's `topicPrefix` (the `conversation` step's title), the
// workflow-formula structure test (`needs` edges), and the widget/formula coupling test (step
// ids, titles, and which steps are gated) — and three hand-rolled copies had already drifted
// apart in detail, so a future formula syntax change could break one of them silently. Plain
// string scanning: the package ships no TOML parser.

/**
 * Parse the `[[steps]]` blocks of a formula source into ordered `{ id, title, needs, gated }`
 * records. `gated` is true when a `[steps.gate]` block follows the step; a `[steps.gate]` also
 * ends the current step (nothing after it belongs to that step). Steps with no `id` are dropped.
 */
export function parseFormulaSteps(source) {
  const steps = [];
  let cur = null;
  for (const line of String(source ?? "").split("\n")) {
    if (line.trim() === "[[steps]]") {
      cur = { id: null, title: "", needs: [], gated: false };
      steps.push(cur);
      continue;
    }
    if (line.startsWith("[steps.gate]")) {
      if (cur) cur.gated = true;
      cur = null;
      continue;
    }
    if (!cur) continue;
    const id = line.match(/^id\s*=\s*"([^"]+)"/);
    if (id) {
      cur.id = id[1];
      continue;
    }
    const title = line.match(/^title\s*=\s*"([^"]*)"/);
    if (title) {
      cur.title = title[1];
      continue;
    }
    const needs = line.match(/^needs\s*=\s*\[(.*)\]/);
    if (needs) cur.needs = [...needs[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }
  return steps.filter((s) => s.id);
}
