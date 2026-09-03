---
status: accepted
---

# Hand off with commits and the outgoing agent's reasoning

Every descent of the fallback chain opens a fresh session — including a descent
to another model on the same CLI, which used to resume the existing one. The new
session receives the same prompt plus a progress section: the branch, the commits
it carries, and the last three reasoning chains of the outgoing session,
reproduced verbatim.

Resuming replayed a whole transcript to change a model, which is slow and is what
made a fallback feel like a stall. It also left two behaviours in the coordinator
depending on whether the rung crossed a CLI boundary. One path is now enough:
fresh session, same prompt, same progress section, whichever rung comes next.

This supersedes ADR-0025, which held that nothing the outgoing session said may
travel, because an exhausted account cannot be interrogated and its prose is not
verifiable. That reasoning is accepted and overridden deliberately: the reasoning
chains are not asked for and not paraphrased — they are the last three the stream
already emitted, passed through as-is, and every CLI adapter already parses them
(they are rendered today at `debug` severity and then discarded). They are
presented as what they are, the previous agent's last thoughts, not as a
verified account of what landed. What landed is the commit list beside them.

Descent now has two causes, not one: provider exhaustion, and a session silent
past the idle timeout. A stuck agent and an exhausted quota mean the same thing
to the loop — this rung is not producing, try the next — so ADR-0024 is amended
rather than kept as written. The two are distinguished only when the whole chain
is spent: exhausted by quota, the run waits and retries from the head, because
quota returns on its own; exhausted by silence, the unit fails ordinarily and
the drain continues, because a prompt that hung three CLIs will hang the fourth
attempt too.
