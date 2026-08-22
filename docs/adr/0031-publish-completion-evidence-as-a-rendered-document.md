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
the issue, with the screenshots shown from the commit that carries them. HTTP
evidence is a browser capture — an `http-json` file that names its endpoint, its
headers, its bodies, its status and the screenshot of the Chrome MCP browser the
exchange was performed in — and that named screenshot must travel as `screen`
evidence in the same manifest.

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
than another, so the field fell back to a wall of monospace. The shape is
checked when the manifest is written — the same gate the coordinator later reads
through — so a file in any other form is refused while the session is still
alive to rewrite it, rather than at the last gate with the pull requests already
merged.

The screenshot requirement follows the same reasoning as the evidence rule it
extends (ADR-0008): evidence of an endpoint is trustworthy when a human can see
the exchange in the browser that performed it. A capture that named an image
nobody attached would publish an exchange with no picture of it, so the
cross-check lives with the manifest, where every evidence entry is known, and
not inside the one file that names the image.

Rendering never costs a delivery its closure. A screenshot with no attachment is
named instead of shown, a file that cannot be read is left out rather than
propagated as a failure, and a GitHub comment that would exceed what GitHub
accepts is cut at a section boundary — with the marker that a rerun recognises
and the issue reference that ties a pull request to its issue added after the
cut, so no truncation can drop either.
