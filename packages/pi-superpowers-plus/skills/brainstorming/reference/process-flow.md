## Process Flow

```dot
digraph brainstorming {
    "Pour workflow molecule\n+ render widget" [shape=box, style=bold, color=red];
    "Step 0 complete\n(widget shown)?" [shape=diamond];
    "Explore project context" [shape=box];
    "Ask clarifying questions" [shape=box];
    "Propose 2-3 approaches" [shape=box];
    "Present design sections" [shape=box];
    "User approves design?" [shape=diamond];
    "Write design doc" [shape=box];
    "Spec self-review\n(fix inline)" [shape=box];
    "User reviews spec?" [shape=diamond];
    "Print /plan for user; user runs it" [shape=doublecircle];

    "Pour workflow molecule\n+ render widget" -> "Step 0 complete\n(widget shown)?";
    "Step 0 complete\n(widget shown)?" -> "Pour workflow molecule\n+ render widget" [label="no, not yet"];
    "Step 0 complete\n(widget shown)?" -> "Explore project context" [label="yes"];
    "Explore project context" -> "Ask clarifying questions";
    "Ask clarifying questions" -> "Propose 2-3 approaches";
    "Propose 2-3 approaches" -> "Present design sections";
    "Present design sections" -> "User approves design?";
    "User approves design?" -> "Present design sections" [label="no, revise"];
    "User approves design?" -> "Write design doc" [label="yes"];
    "Write design doc" -> "Spec self-review\n(fix inline)";
    "Spec self-review\n(fix inline)" -> "User reviews spec?";
    "User reviews spec?" -> "Write design doc" [label="changes requested"];
    "User reviews spec?" -> "Print /plan for user; user runs it" [label="approved"];
}
```

**The terminal state is handing off:** after the user approves, print **`Type /plan to continue`** — do NOT attempt to invoke writing-plans yourself; the user runs the command so the skill loads via pi expansion. Do NOT invoke frontend-design, mcp-builder, or any other implementation skill — writing-plans (via `/plan`) is the only onward step.
