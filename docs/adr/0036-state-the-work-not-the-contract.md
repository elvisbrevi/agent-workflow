---
status: accepted
---

# State the work, not the contract

The delivery prompt names the issue and the skills that implement it, and
nothing else. It carries no marker vocabulary, no completion-manifest
instruction, no evidence specification, and no prose restating what the
authority profile already denies. The GitHub delivery prompt went from 4926
characters of fixed text to 231.

The Azure delivery prompt is the same three lines, preceded by the ticket. The ticket
travels whole rather than as its number, which is the one asymmetry with GitHub and the
reason for it: a delivery session has `gh` and can read an issue itself, but it has no
`az`, so the coordinator's own read is the only way the session learns what was asked.
What went with the rest of the fixed text is what the manifest and the evidence system
had put there — the manifest invocation, the evidence specification, the workflow phase,
the completion gates and the marker — none of which the session decides.

Everything removed had the same shape: a rule the coordinator could enforce,
written instead as a request the model was asked to honour. The manifest
described a file the coordinator could compute; the evidence specification
described artifacts nothing downstream reads any more (ADR-0037); the fencing
paragraphs — *do not select another issue, do not push, do not open a pull
request, do not print the coordinator's markers* — restated deny rules the CLI
already enforces per ADR-0021. Keeping both meant that every escape produced
another paragraph rather than a tighter profile, which is how the prompt reached
its size.

Two of those clauses survive on purpose, at the operator's instruction: *no abras
PR, no me hagas preguntas*. Both restate a boundary the profile already holds, so
by this ADR's own reasoning they are redundant — the operator wanted them said
anyway, and one line is not the paragraph this decision was about. They are the
exception, not the pattern; a third escape belongs in the profile.

The prompt says *commit*, and not *push*, precisely because the profiles are the
authority: `git push` is denied in all three, and the coordinator pushes the
verified commit itself. An earlier draft of this prompt said "comitea y push" and
would have hit that deny on every delivery.

The issue arrives as its number alone. The session runs inside the repository
with `gh` available, so reading the title, body and comments is one deterministic
call it makes itself, against the issue as it stands rather than against the
snapshot the coordinator took before opening the session.

The last instruction is the only one that asks for something the coordinator
cannot derive: a human-readable summary of what was done. That summary is the
delivery's only narrative artifact (ADR-0037).
