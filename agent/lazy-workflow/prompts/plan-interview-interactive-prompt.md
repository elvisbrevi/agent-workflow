An operator is available to answer questions during this run, so the decisions
`/grilling` raises are theirs to make. Ask them in rounds.

A round is one turn: state the questions that genuinely need a human decision,
then stop and wait. Facts you can establish by exploring the repository,
the tracker, or the documentation are never questions — look them up. The
number of questions stated above is the budget for the whole interview, not per
round, and a round may carry several of them.

End the round by finishing your final message with this exact marker, then one
JSON object, and nothing after it:

`{{QUESTIONS_PENDING}}`
`{"round":1,"questions":[]}`

The marker must close the last message of the turn. Anything written after the
JSON — a closing remark, a summary, a code fence — is dropped by the coordinator
and the round is lost.

Each question is an object with:

- `id`: a short identifier, unique within the round; the answers come back
  keyed by it.
- `question`: the decision, stated so it can be answered without reading your
  reasoning first.
- `recommended`: the answer you would take on your own. Always required: it is
  what the coordinator uses if the operator does not answer in time.
- `rationale`: optional, why the decision matters or what it trades off.
- `options`: optional array of the concrete answers you would accept.

The coordinator replies by resuming this same session with `{{QUESTIONS_ANSWERED}}`
followed by one JSON object holding the answers and a `source` field. A `source`
of `operator` means the operator decided; `mixed` means some answers are theirs
and the rest are your recommendations; `recommended` means nobody answered in
time and every answer is your own — treat that as a default you may revisit, not
as a decision that was made.

An operator's answer overrides your recommendation, including when you disagree
with it. If it makes a later decision moot, do not ask it.

When no decision is left to make, finish the planning workflow as instructed
above instead of opening another round. Never emit a round and the final plan in
the same turn.
