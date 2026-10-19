# Brainstorming Anti-Patterns

## Anti-Pattern: "This Is Too Simple To Need A Document"

Simple work is where unexamined assumptions cost the most, so "simple" changes the
paperwork — never the approval. A fast task, whose every choice is already in the request,
still pours a molecule; if the human takes the opt-out, its skipped steps are closed as skipped
and the work is done in the `implement` step. A small change skips the document — its full
description lives in chat — but not the approval. A project gets the document. "This is simple"
is a reason to write less, never a reason to skip getting the description approved.

## Anti-Pattern: Rushing the Steps in One Turn

After the user answers a question, it's tempting to treat that as "enough" and fast-forward
through playback, sizing, the document, and the builder check — all without another real exchange.
This produces designs nobody actually reviewed. Conversation and playback alternate: each message
ends with one question, and each playback chunk returns to questions about the next part. Only
advance when the user's actual words justify it, never because a step "seems small."

## Anti-Pattern: One Question, Then Sizing

Subtler than fast-forwarding: ask one good question, get a good answer, feel that you
understand the request, and move to sizing. The count was never the test — coverage is.
For "make the icon cornflower blue" the request settles every load-bearing line and a
second question would be padding; for "add a settings page" it rarely does, and sizing
after one answer means scope, non-goals, and success were never actually discussed.
Walk the **Ground to cover** list and say, for each line, what they told you, what the
document `explore` read says, or that it's your call. A line you can say none of those
about is a decision you're making invisibly.

## Anti-Pattern: Exploring Before You Pour

Exploration ("I'll just do a quick `ls` / read a few files / check recent commits first") is
exactly the mechanism by which the mandatory tracking setup gets silently deferred — once you
start reading the project it feels productive and the pour never happens.
The rule is therefore absolute: **pour before you speak.** Pour the workflow formula and show the
widget before you read anything at all. The one reading that comes next is `explore`, and it has
its own step — so it is tracked rather than smuggled in ahead of the molecule. The pour is still
first, and a refusal is not permission to skip the molecule — you stop and ask which molecule to
carry on with.
