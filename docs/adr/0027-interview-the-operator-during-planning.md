---
status: accepted
---

# Interview the operator during planning

A planning run may stop, hand its open decisions to the operator, and continue
from the answers. The questions travel through a channel the coordinator owns —
a local HTTP page, the terminal, or a pair of JSON files — and the answers come
back into the same session, which is resumed rather than replaced.

Planning is the one workflow where a human decision is load-bearing. The
`/grilling` skill our planning prompts invoke was written to ask one question at
a time and wait for the answer, precisely because the decisions are the
operator's; the `autoplan` prompt then told the session to *accept the
recommended answer for each question*, which turned an interview into a
monologue. The instruction was right for the run it was written for — nobody was
listening — but it was stated as if nobody ever would be. It is now one of two
policies, chosen per run, and the session receives exactly the one that applies.

The pause is a marker in the session's own text, not a signal on its stream.
The stream already carries terminal markers, and a terminal marker means the
work is over: it cuts the stream short and closes the session with it. The
session that must answer the next round is the very one that would be deleted,
so the round is read from the finished turn instead. That also fixes what a
round may look like: the marker and its JSON must close the last message of the
turn, because Claude Code's result is its final message while OpenCode's is
every message concatenated, and only the tail is common ground.

The channel is a seam with three adapters rather than a prompt read from stdin.
The coordinator decides what an interview is — how many rounds, what an expired
deadline means, which session is resumed — and a channel only carries. That
split is what made the file channel sixty lines: anything that can write JSON
can answer a planning interview, so a GUI, a mail bridge, a chat bot or another
agent is an adapter and not a change to planning. The session itself never
touches a channel; it prints a marker and reads what it is handed on resume,
which is why the authority profiles are untouched. A channel the session could
drive would be a network endpoint in the model's hands and a different decision
from this one.

An unanswered round resolves to the answers the session recommended, and the run
continues. Failing closed is right for a mutation — and this repository fails
closed on most of them — but a plan is not a mutation, and the run that nobody
is watching is the normal run. That is also why a recommendation is mandatory in
every question rather than optional: it is the value the deadline resolves to,
and a question without one would make an unattended run stop at the first thing
the session could not decide alone. The payload says which answers were the
operator's, so a default is never presented to the session as a decision.

The interview is off unless it is asked for. Every existing planning run
behaves exactly as it did, and an interactive run that cannot announce itself —
`--quiet` silences the URL, the prompt and the exchange paths alike — is
rejected as an argument error rather than hanging silently.

There is no fallback descent and no checkpoint. The chain descends on provider
exhaustion by resuming or handing off a unit of delivery work, and a rung with
no memory of the earlier rounds cannot continue an interview; an exhausted
interview stops with the partial result and the session id it was using. A plan
writes nothing, so an interrupted interview has no state to reconcile — the
round is lost, nothing else is, and an Azure planning session can still be
resumed by hand with `--session`, which it already accepted.
