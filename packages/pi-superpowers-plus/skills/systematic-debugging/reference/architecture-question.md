# When 3+ Fixes Fail: Question Architecture

**This is NOT a failed hypothesis — it's a wrong architecture.**

Pattern indicating architectural problem:
- Each fix reveals new shared state/coupling in different places
- Fixes require "massive refactoring" to implement
- Each fix creates new symptoms elsewhere

**STOP and question fundamentals:**
- Is this pattern fundamentally sound?
- Are we sticking with it through sheer inertia?
- Should we refactor architecture vs. continue fixing symptoms?

**Discuss with your human partner before attempting more fixes.**
