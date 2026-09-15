# Task Template

Each task is one task bead. The template below is the exact shape of every task bead's
`description` — what `beads_create({ title, description })` writes. The markdown
heading `### Task N: [Component Name]` is the bead's TITLE, not a heading in a
document:
Set the bead title to `Task N: <name>`; the description body starts after the
heading (do not include the `### Task N:` heading in the description).

Each task's Acceptance Criteria are also passed as the `acceptance` field in
`beads_create_list` so `bd lint` is clean for every task bead.

**Optional `**Gate:**` line.** When a task's covering-test command is known up front (common for package-scoped tasks, e.g. `` `cd packages/statusline && npm test` ``), declare it as a `**Gate:** <re-runnable command>` line at the end of the task body. The wave-parallel execution route (subagent-driven-development) gates the implementer on a declared gate — a non-zero exit fails the agent. Omit it when the covering command is unknown or the task is doc-only (no gate); the implementer's report may still name a command for the fix loop.

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [what this task uses from earlier tasks — exact signatures]
- Produces: [what later tasks rely on — exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

**Acceptance Criteria:**
- [ ] [observable, checkable outcome — one per line]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```

### Task N+1: [Next Component Name]

(Repeat the same shape for every task.)
````
