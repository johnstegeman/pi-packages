# Step Red Flags

A step is done when the implementer can write exactly one reasonable thing
from it. That is the whole requirement: **unambiguous, not complete.** Two
opposite failures break it, and a plan can have both.

## A gap — a line that decides nothing

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without the test's name and its assertions)
- "Similar to Task N" (the implementer may read tasks out of order — the
  Interfaces block is what carries the shared signature)
- A type, function, or method no task defines

## A transcript — a body the signature and tests already determine

- A function body in a code step whose signature and covering test pin the
  behavior; the implementer writes the body
- Exact copy that no step in the spec fixes

A plan is the set of decisions the implementer cannot make alone. A plan
longer than the code it describes has written the code instead.
