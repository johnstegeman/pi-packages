## The Process

**The working directory.** Files, docs, and recent commits you look at belong to the user's
current working directory, not this skill's install directory (see `using-superpowers` →
Working Directory).

**YAGNI ruthlessly.** Remove unnecessary features from every approach and design. A capability
nobody asked for is one the design has to justify.

**Working in existing codebases.** Explore the current structure before proposing changes and
follow existing patterns. Where existing code has problems that affect the work — a file that has
grown too large, unclear boundaries, tangled responsibilities — include targeted improvements as
part of the design, the way a good developer improves code they are working in. Don't propose
unrelated refactoring. `writing-plans` carries the full guidance in its
[File Structure section](../../writing-plans/SKILL.md); it is not duplicated here.

**Design for isolation and clarity.** *(A local addition; upstream removed this text.)* Break the
system into smaller units that each have one clear purpose, communicate through well-defined
interfaces, and can be understood and tested independently. For each unit you should be able to
answer: what does it do, how do you use it, and what does it depend on? Can someone understand
what a unit does without reading its internals? Can you change the internals without breaking
consumers? If not, the boundaries need work.

### Spec Self-Review

While writing the document — not after — look at it with fresh eyes. This is the mechanical check
that runs alongside the builder check, not a substitute for it.

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick one and make it explicit.

Fix any issues inline; the outcome is recorded in `write-spec`'s close reason.
