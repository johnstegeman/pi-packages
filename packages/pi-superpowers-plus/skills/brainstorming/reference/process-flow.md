## Process Flow

```dot
digraph brainstorming {
    "Pre-check: anything non-trivial missing?" [shape=diamond];
    "Do it; say what you did" [shape=box];
    "Pour molecule + show widget" [shape=box];
    "First message (opt-out offer + one question)" [shape=box];
    "Conversation <-> playback" [shape=box];
    "Size the work" [shape=box];
    "Approve the description in chat" [shape=diamond];
    "Write the document" [shape=box];
    "Builder check (spec-review)" [shape=box];
    "User approves the document?" [shape=diamond];
    "Print /plan for user; user runs it" [shape=doublecircle];
    "Build it directly in the implement step" [shape=doublecircle];

    "Pre-check: anything non-trivial missing?" -> "Do it; say what you did" [label="no, quick task"];
    "Pre-check: anything non-trivial missing?" -> "Pour molecule + show widget" [label="yes"];
    "Pour molecule + show widget" -> "First message (opt-out offer + one question)";
    "First message (opt-out offer + one question)" -> "Conversation <-> playback";
    "Conversation <-> playback" -> "Conversation <-> playback" [label="play back, then next question"];
    "Conversation <-> playback" -> "Size the work";
    "Size the work" -> "Approve the description in chat" [label="small change"];
    "Size the work" -> "Write the document" [label="project"];
    "Approve the description in chat" -> "Build it directly in the implement step" [label="approved"];
    "Write the document" -> "Builder check (spec-review)";
    "Builder check (spec-review)" -> "User approves the document?";
    "User approves the document?" -> "Write the document" [label="changes requested"];
    "User approves the document?" -> "Print /plan for user; user runs it" [label="approved"];
}
```

**The terminal state:** a **project** hands off — after the user approves the document, print
**`Type /plan to continue`**; do NOT attempt to invoke writing-plans yourself, the user runs the
command so the skill loads via pi expansion. Do NOT invoke frontend-design, mcp-builder, or any
other implementation skill — writing-plans (via `/plan`) is the only onward step. A **small
change** does not hand off: its description is approved in chat, the document steps are resolved
or skipped, and the work is done directly in the `implement` step (close it when done).
