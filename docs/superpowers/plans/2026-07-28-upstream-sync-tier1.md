# Upstream Sync Tier 1 Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Bring three Tier 1 changes from the original `obra/superpowers` into this fork: two verbatim copies and one replacement (Approach A).

**Architecture:** Items 1 & 2 are verbatim content copies of shared files the fork left pristine — no merge, no logic. Item 3 replaces `testing-anti-patterns.md` with the upstream's `writing-good-tests.md`, repoints the `tdd-anti-patterns` reference topic (keeping the topic name), and rewrites the TDD SKILL.md section. Item 3's reference-tool repoint is a real TDD cycle (existing test asserts stale content).

**Tech Stack:** Markdown skill docs, TypeScript (workflow-monitor reference-tool), vitest, biome.

**Source of truth:** `obra/superpowers` @ HEAD = commit `3dcbd5c` (v6.2.0). Conversion snapshot = `a98c5df` (v4.2.0). Files in this plan are inlined verbatim from HEAD so the work does not depend on the ephemeral `/tmp/obra-superpowers` clone.

**Branch:** `feat/skills-upstream-sync` (current — no new branch).

---

### Task 1: Copy upstream `find-polluter.sh` bug fixes (verbatim)

**TDD scenario:** Trivial change — content copy, no logic to test.

**Files:**
- Modify: `skills/systematic-debugging/find-polluter.sh` (replace entire contents)

**Why:** Fork's copy is pristine (identical to conversion snapshot `a98c5df`). Upstream has two bug-fix commits since conversion: `6015d37` (match `find -path ./` prefix) and `c8921b5` (accept `./`-prefixed patterns and match top-level tests).

**Step 1: Replace `skills/systematic-debugging/find-polluter.sh` with this exact content**

```bash
#!/usr/bin/env bash
# Bisection script to find which test creates unwanted files/state
# Usage: ./find-polluter.sh <file_or_dir_to_check> <test_pattern>
# Example: ./find-polluter.sh '.git' 'src/**/*.test.ts'

set -e

if [ $# -ne 2 ]; then
  echo "Usage: $0 <file_to_check> <test_pattern>"
  echo "Example: $0 '.git' 'src/**/*.test.ts'"
  exit 1
fi

POLLUTION_CHECK="$1"
TEST_PATTERN="$2"

echo "🔍 Searching for test that creates: $POLLUTION_CHECK"
echo "Test pattern: $TEST_PATTERN"
echo ""

# Get list of test files (find . emits ./-prefixed paths, so accept the
# pattern written with or without a leading ./)
TEST_PATTERN="${TEST_PATTERN#./}"
# find -path can't match '**/' against zero directory levels, so a pattern
# like src/**/*.test.ts would skip src/top.test.ts; also try the pattern
# with '**/' collapsed to cover files directly under the base directory.
TEST_FILES=$(find . \( -path "./$TEST_PATTERN" -o -path "./${TEST_PATTERN//\*\*\//}" \) | sort -u)
if [ -z "$TEST_FILES" ]; then
  TOTAL=0
else
  TOTAL=$(printf '%s\n' "$TEST_FILES" | wc -l | tr -d ' ')
fi

echo "Found $TOTAL test files"
echo ""

COUNT=0
for TEST_FILE in $TEST_FILES; do
  COUNT=$((COUNT + 1))

  # Skip if pollution already exists
  if [ -e "$POLLUTION_CHECK" ]; then
    echo "⚠️  Pollution already exists before test $COUNT/$TOTAL"
    echo "   Skipping: $TEST_FILE"
    continue
  fi

  echo "[$COUNT/$TOTAL] Testing: $TEST_FILE"

  # Run the test
  npm test "$TEST_FILE" > /dev/null 2>&1 || true

  # Check if pollution appeared
  if [ -e "$POLLUTION_CHECK" ]; then
    echo ""
    echo "🎯 FOUND POLLUTER!"
    echo "   Test: $TEST_FILE"
    echo "   Created: $POLLUTION_CHECK"
    echo ""
    echo "Pollution details:"
    ls -la "$POLLUTION_CHECK"
    echo ""
    echo "To investigate:"
    echo "  npm test $TEST_FILE    # Run just this test"
    echo "  cat $TEST_FILE         # Review test code"
    exit 1
  fi
done

echo ""
echo "✅ No polluter found - all tests clean!"
exit 0
```

**Step 2: Verify the change**

Run: `git diff skills/systematic-debugging/find-polluter.sh`
Expected: only the `TEST_PATTERN`/`TEST_FILES` block changes (the `find` invocation). The rest is unchanged.

**Step 3: Commit**

```bash
git add skills/systematic-debugging/find-polluter.sh
git commit -m "fix(systematic-debugging): port find-polluter.sh bug fixes from upstream

Accept ./-prefixed test patterns and match top-level test files.
Verbatim from obra/superpowers @ 6015d37, c8921b5."
```

---

### Task 2: Anonymize example path in `root-cause-tracing.md` (verbatim)

**TDD scenario:** Trivial change — content copy, no logic to test.

**Files:**
- Modify: `skills/systematic-debugging/root-cause-tracing.md` (1 line)

**Why:** Fork's copy is pristine (identical to conversion snapshot). Upstream anonymized an example path for privacy/portability.

**Step 1: Edit line 36 of `skills/systematic-debugging/root-cause-tracing.md`**

Change:
```
Error: git init failed in /Users/jesse/project/packages/core
```
to:
```
Error: git init failed in ~/project/packages/core
```

**Step 2: Verify the change**

Run: `git diff skills/systematic-debugging/root-cause-tracing.md`
Expected: exactly one line changed (the example error message), nothing else.

**Step 3: Commit**

```bash
git add skills/systematic-debugging/root-cause-tracing.md
git commit -m "docs(systematic-debugging): anonymize example path in root-cause-tracing

Verbatim from obra/superpowers upstream."
```

---

### Task 3: Replace `testing-anti-patterns.md` with `writing-good-tests.md` (TDD)

**TDD scenario:** Modifying tested code — the reference-tool test asserts stale content. Change the assertion first (RED), then implement (GREEN).

**Files:**
- Modify: `tests/extension/workflow-monitor/reference-tool.test.ts` (test assertion, lines 27-30)
- Create: `skills/test-driven-development/writing-good-tests.md`
- Modify: `extensions/workflow-monitor/reference-tool.ts` (repoint topic, line 13)
- Modify: `skills/test-driven-development/SKILL.md` (rewrite "Testing Anti-Patterns" section + Reference line)
- Delete: `skills/test-driven-development/testing-anti-patterns.md`

**Step 1: Write the failing test (RED)**

In `tests/extension/workflow-monitor/reference-tool.test.ts`, replace this test:

```typescript
  test("loads tdd-anti-patterns (existing file)", async () => {
    const content = await loadReference("tdd-anti-patterns");
    expect(content).toContain("Anti-Pattern");
  });
```

with:

```typescript
  test("loads tdd-anti-patterns (writing-good-tests content)", async () => {
    const content = await loadReference("tdd-anti-patterns");
    expect(content).toContain("Name the Break");
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/workflow-monitor/reference-tool.test.ts`
Expected: FAIL — `tdd-anti-patterns` still points at `testing-anti-patterns.md`, which does not contain "Name the Break" (the old doc only contains "Anti-Pattern").

**Step 3: Create `skills/test-driven-development/writing-good-tests.md` with this exact content**

```markdown
# Writing Good Tests

**Load this reference when:** writing or changing tests, adding mocks, or
adding cleanup/helper methods for tests.

## Overview

A test exists to catch a specific break. Two principles govern everything
here:

```
1. Every test names the break it catches
2. Every test exercises the real thing
```

Strict TDD produces both naturally: a test written first and watched
failing against real code has already proven it can fail, and only earns
a mock when the real dependency proves slow or external.

## Principle 1: Name the Break

Before writing the test body, answer: **what production change should
make this test fail — and is that change a bug or a decision?** A test
earns its place by catching a wrong branch, missing side effect, wrong
argument, boundary case, or broken contract.

**Derive expectations independently.** Use literals and hand-checked
fixtures; table-driven tests with literal `want` values are the preferred
shape. An expectation computed by the code under test — or its helpers —
passes no matter what that code does:

```typescript
// ❌ Mirror assertion: the same builder computes both sides — always true
const expected = buildSearchQuery({ tag: 'urgent' });
expect(buildSearchQuery({ tag: 'urgent' })).toBe(expected);

// ✅ Hand-derived literal
expect(buildSearchQuery({ tag: 'urgent' })).toBe('tag:"urgent"');
```

**No change detectors.** If only intentional decisions can fail a test —
a constant's value, exact message wording, private structure — it fires
on redesign and sleeps through bugs. Test the behavior that depends on
the decision: not `expect(MAX_RETRIES).toBe(5)` but "a failing call is
retried 5 times and the 6th attempt never happens."

**Behavior, not text.** Asserting that a script, skill, or config
contains an exact line proves only that the source is the source. Run
scripts against controlled inputs and assert outputs, side effects, or
exit codes. Documents that instruct agents are tested by the consuming
agent's behavior (superpowers:writing-skills); prose for humans earns no
test at all.

**Your code, not the framework.** Test the contract your code makes at
its boundaries — the route you register, the query you emit, the payload
you produce. Upstream mechanics are their maintainers' tests to write
(the classic: asserting your router invokes a registered handler — that
is the framework's test, not yours). When upstream behavior genuinely
surprised you, write one narrow characterization test naming the
assumption. The same boundary applies inside your code: constructors,
getters, constants, and trivial forwarding earn tests only when they
validate, normalize, default, derive, enforce, or cause side effects —
otherwise assert the first consumer-visible result that depends on them.

### Gate Function

```
BEFORE writing the test body:
  Name the production change that would make this test fail.

  Cannot name one            → redesign around an observable behavior
  "The source text changed"  → run the artifact and assert its effects
  Only intentional decisions → change detector; test the behavior
                               that depends on the decision

  Confirm the expected value is derived without the code under test.
  IF it reuses the code's logic or helpers:
    Replace it with a literal or hand-checked fixture
```

## Principle 2: Exercise the Real Thing

**The mock earns no assertions.** A mock assertion passes when the mock
is present and fails when it is absent — it says nothing about the
component. Assert the real component's behavior; if the mock is what you
are checking, unmock it or delete the assertion.

```typescript
// ✅ Real behavior
expect(screen.getByRole('navigation')).toBeInTheDocument();

// ❌ Mock existence
expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
```

**your human partner's correction:** "Are we testing the behavior of a
mock?"

**Mock at the right level.** Learn every side effect of the real method
before replacing it; mock the slow or external operation and keep what
the test depends on real. When unsure, run the test against the real
implementation first and observe what actually needs to happen.

```typescript
// ❌ The mock swallows the config write that duplicate detection reads
vi.mock('ToolCatalog', () => ({
  discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
}));

// ✅ Mock only the slow server startup; the config write stays real
vi.mock('MCPServerManager');
```

**Make doubles specific.** When arguments, call counts, or ordering are
part of the contract, assert them — a fake that accepts anything verifies
nothing. Give each branch (success, error, malformed) its own fixture or
spy, so the wrong branch cannot satisfy the expectation.

**Mirror real data completely.** Mock the complete structure as it exists
in reality — all documented fields — not just the ones your test reads.
Partial mocks fail silently when downstream code reads an omitted field:
the test passes while integration breaks.

**Production classes carry production methods only.** Cleanup that only
tests need lives in test utilities, never as a `destroy()` on the
production class. Ask: is this method called only from tests? Does this
class own this resource's lifecycle? Wrong answers → test utility.

**Prefer real components over complex mocks.** When mock setup outgrows
the test logic, mocks miss methods the real components have, or tests
break when the mock changes, switch to an integration test with real
components. **your human partner's question:** "Do we need to be using a
mock here?"

### Gate Function

```
BEFORE adding a mock or test helper:
  List the real method's side effects; keep the ones the test
  depends on real — mock the slow/external level below them.

  Mock responses mirror the complete real structure.

  A method only tests call lives in test utilities, not production.

  About to assert on the mock itself?
    Unmock it or delete the assertion.
```

## Tests Ship With the Implementation

The TDD cycle — failing test, minimal implementation, refactor — is what
"complete" means. Ship the tests the behavior needs and only those:
trivial code and human prose earn none, and a test written to satisfy
process costs maintenance forever.

## The Mutation Check

Before finishing, mentally mutate the production code; at least one test
should fail for each realistic mutation:

- Wrong constant or argument
- Wrong branch handler
- Missing state change or side effect
- Empty or default return
- Missing validation for zero, empty, nil, unauthorized, or malformed input

A mutation nothing catches marks the behavior as unprotected — or the
test as tautological.

## Quick Reference

| When you... | Do |
|-------------|-----|
| Write any test | Name the break it catches — a bug, not a decision |
| Build an expected value | Derive it by hand; never with the code under test |
| Test a script or document | Run it / pressure-test its consumer; never grep its text |
| Reach for a dependency test | Test your boundary contract, not their documented mechanics |
| Want to assert on a mocked element | Test the real component, or unmock it |
| Are about to mock a method | Learn its side effects; mock the slow/external level |
| Build a mock response | Mirror the real structure completely |
| Need cleanup only tests use | Put it in test utilities |
| Watch mock setup balloon | Switch to an integration test with real components |
| Finish a test file | Run the mutation check |

## Warning Signs

- Setup and assertion share the same object, guaranteeing equality
- The test can fail only through a panic, crash, or missing selector
- The test fails on every intentional change, never on accidental breakage
- Expected values are hidden behind loops, builders, or helpers
- The test greps source text, or asserts a removed symbol stays removed
- The test would still matter if only the framework remained
- The test exists for coverage, checking no side effect or outcome
- An assertion checks a `*-mock` test ID, or fails if you remove the mock
- A method is called only from test files
- Mock setup is more than half the test, or you can't explain why the mock is needed
- Mocking "just to be safe"
```

**Step 4: Repoint the reference topic**

In `extensions/workflow-monitor/reference-tool.ts`, change this line (line 13):

```typescript
  "tdd-anti-patterns": "skills/test-driven-development/testing-anti-patterns.md",
```
to:
```typescript
  "tdd-anti-patterns": "skills/test-driven-development/writing-good-tests.md",
```

Keep the topic name `tdd-anti-patterns` unchanged (the test at line 9 asserts it is in `REFERENCE_TOPICS`; this stays green).

**Step 5: Run test to verify it passes (GREEN)**

Run: `npx vitest run tests/extension/workflow-monitor/reference-tool.test.ts`
Expected: PASS — `tdd-anti-patterns` now loads `writing-good-tests.md`, which contains "Name the Break".

**Step 6: Rewrite the TDD SKILL.md section**

In `skills/test-driven-development/SKILL.md`, replace this section:

```markdown
## Testing Anti-Patterns

When adding mocks or test utilities, read `testing-anti-patterns.md` in this skill directory to avoid common pitfalls:
- Testing mock behavior instead of real behavior
- Adding test-only methods to production classes
- Mocking without understanding dependencies
```

with:

```markdown
## Writing Good Tests

When writing or changing tests, adding mocks, or adding cleanup/helper methods, read `writing-good-tests.md` in this skill directory. Two principles:

- **Name the break** — every test names the production change that should make it fail (a bug, not a decision); derive expectations by hand, never with the code under test; no change detectors; assert behavior, not source text
- **Exercise the real thing** — the mock earns no assertions; mock at the right level, mirror real data completely, keep production classes production-only; run the mutation check before finishing
```

Then in the same file's `## Reference` section, replace this line:

```markdown
- `tdd-anti-patterns` — Mock pitfalls, test-only methods, incomplete mocks
```
with:
```markdown
- `tdd-anti-patterns` — Writing good tests: name the break, exercise the real thing, mutation check
```

**Step 7: Delete the old file**

Run: `git rm skills/test-driven-development/testing-anti-patterns.md`

**Step 8: Verify nothing else references the deleted file**

Run: `grep -rn "testing-anti-patterns\.md" extensions/ skills/ tests/`
Expected: no matches in `extensions/`, `skills/`, or `tests/`. (Historical `docs/plans/*` and `docs/specs/*` references are out of scope — they are records of past work, not live references.)

**Step 9: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the reference-tool tests and the error-handling test (which uses `tdd-rationalizations`, unaffected).

**Step 10: Run lint**

Run: `npm run lint`
Expected: clean (biome checks TS; the new `.md` files are not linted by biome).

**Step 11: Commit**

```bash
git add skills/test-driven-development/writing-good-tests.md \
        skills/test-driven-development/SKILL.md \
        skills/test-driven-development/testing-anti-patterns.md \
        extensions/workflow-monitor/reference-tool.ts \
        tests/extension/workflow-monitor/reference-tool.test.ts
git commit -m "feat(tdd): replace testing-anti-patterns with writing-good-tests (Approach A)

Adopt upstream's two-principle rewrite: Name the Break + Exercise the
Real Thing + Mutation Check. Repoint the tdd-anti-patterns reference
topic to writing-good-tests.md (topic name kept for backward compat).
Verbatim content from obra/superpowers @ HEAD."
```

---

## Verification (after all three tasks)

- `npm test` — all green.
- `npm run lint` — clean.
- `git log --oneline -3` — three commits, one per item.
- Manual spot-check: `loadReference("tdd-anti-patterns")` returns writing-good-tests content (covered by the updated test).
