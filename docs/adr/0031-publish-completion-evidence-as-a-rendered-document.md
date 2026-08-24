---
status: accepted
---

# Publish completion evidence as a rendered document

Completion evidence reaches the tracker as a document the coordinator renders,
not as the bytes of a file. For an Azure ticket the completion-evidence field
carries one HTML document with the delivery's identities, the validations that
ran, every HTTP exchange laid out as endpoint, header tables and pretty-printed
bodies, every command output, and every screenshot shown inline from the
attachment already uploaded for it. For a GitHub issue the same document is
rendered as Markdown into the pull-request body and into the comment that closes
the issue, with the screenshots shown from the commit that carries them — one
repository's worth for a pull request, every changed repository's for a closure,
since the issue a transversal delivery closes is the issue of all of them. HTTP
evidence is a browser capture — an `http-json` file that names its endpoint, its
headers, its bodies, its status and the screenshot of the Chrome MCP browser the
exchange was performed in — and that named screenshot must travel as `screen`
evidence in the same manifest, written beside the capture file.

What the tracker showed before was technically evidence and practically
unreadable. The field received the raw bytes of whichever text file the manifest
happened to list first, because one file is all the publishing call was given:
the other captures, the validations, the branch and the commit were already in
the manifest the coordinator had just verified, and none of it was passed on.
The screenshots were worse off — uploaded as attachments and then referenced by
nobody, so a reviewer had to leave the field, open the attachment list, and
guess which image belonged to which request. Rendering is therefore not
decoration; it is the difference between proof a person can audit in one screen
and proof a person has to reassemble.

The renderer is the coordinator's, never the session's. A session that formats
its own HTML formats it differently every run, and a tracker field is exactly
where that inconsistency is most expensive: two tickets from the same delivery
read as work by two different teams. So the session produces content and the
coordinator produces presentation, and both tracker surfaces render from a
single description of the evidence, so what an Azure ticket shows and what a
GitHub issue shows cannot drift apart.

Requiring a shape for `http-json` is what makes the layout possible at all. The
instruction used to ask for "sanitized endpoint/parameters/headers/response
evidence", and a session satisfied it with whatever a terminal had printed: a
pasted `curl` transcript, a body with no endpoint above it, a response
indistinguishable from a request. Nothing in that can be put in one table rather
than another, so the field fell back to a wall of monospace.

The shape is demanded when an Azure manifest is written, and there only. That is the
one moment the session is still alive to rewrite the file, and it is also the
reason the demand must not become a condition of publication: a manifest written
before the shape existed would then fail at a gate reached with the pull requests
already merged — the precise unrecoverable ending this contract exists to
prevent. Evidence in any other form still publishes, as pretty-printed JSON
rather than as a laid-out exchange — which is also what a GitHub delivery does,
since there the file kind is read off an extension and a `.json` that is not a
capture may be perfectly good evidence of something else.

The document names no commit. A transversal delivery has one merge commit per
repository and a single-repository one has exactly one, so a commit among the
document's facts made the same ticket render two different documents depending on
which publication path reached it — and the second to run would then read the
first's evidence as a conflict it could never clear. Every merge commit is
already on the work item as the native artifact link a completion gate requires,
so the field loses nothing by not repeating it.

GitHub evidence must pass the same gate the Azure ticket applies. The rule that
evidence never publishes a credential or executable content belonged to the work
item because the work item was the only place evidence content reached; now the
pull-request body and the closing comment carry the same files, and a repository
is a more public place than a work item. A rule that protects one surface and not
the other protects neither, so it is one rule and both surfaces call it — at the
writing gate, where a session can still redact, and again where the document is
rendered, so a manifest written before the gate cannot publish what the gate
refuses.

GitHub evidence must also be in the commit its manifest names. The published document
shows each screenshot from that commit, and a clean worktree does not answer the
question: `git status --untracked-files=no` cannot see a file that was never
added, so evidence a session wrote but did not commit would leave a permanently
broken image on an issue already closed. The commit is asked directly, at the
writing gate, where committing it is still possible.

The screenshot requirement follows the same reasoning as the evidence rule it
extends (ADR-0008): evidence of an endpoint is trustworthy when a human can see
the exchange in the browser that performed it. A capture that named an image
nobody attached would publish an exchange with no picture of it, so the
cross-check lives with the manifest, where every evidence entry is known, and
not inside the one file that names the image. A capture names its screenshot by
file name, so the pair is only unambiguous where the two live together: in a
transversal delivery both repositories call theirs `pantalla.png`, and matching
on the name alone would show one repository's browser beside the other's
request.

Rendering never costs a delivery its closure. A screenshot with no attachment
keeps its caption — identical to the one it carries once attached, so the same
delivery rendered before and after its upload cannot read as two different
values — a file that cannot be read is left out rather than propagated as a
failure, a repository that cannot be resolved gives up the document rather than
publishing images that point nowhere, a file whose bytes do not decode as text is
left out rather than fenced into a comment as noise — while a file that is only
coloured keeps its text, since a test runner's escape codes are decoration the
document drops rather than evidence it refuses — and a GitHub comment that
would exceed what GitHub accepts is cut at a heading the document itself emitted
— tracked past its own fenced blocks, so a cut never lands inside one — with the
bounded summary, the marker that a rerun recognises and the issue reference that
ties a pull request to its issue all added around the cut, so no truncation can
drop any of them and no session's summary can push the body past what GitHub
accepts. For the same reason a ticket
completed before the field carried a document is recognised by the raw bytes it
still holds, and not reported as a conflict against evidence it already has.

That recognition is why the document ends by naming the files it was rendered
from, each with the first twelve characters of its SHA-256. The same proof
renders differently depending on how much of it the publishing path could see: a
transversal delivery reads every repository's manifest and the repair command
that follows reads one, and rendering itself transforms what it is given — a
capture becomes tables, colour is stripped, a long block is clamped. Comparing
the results as text can therefore only ever say they differ, and a delivery
would report a conflict against its own evidence at a gate reached with the pull
requests already merged. Digests survive rendering, so the question asked of a
field that already holds a document is whether it names these ones. A repair
command that cannot be rerun is not a repair command.
