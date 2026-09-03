---
status: accepted
---

# Close a delivery with the agent's summary

The completion manifest and the evidence system are removed. What closes a
delivery is the last text the session produced: it becomes the body of the
GitHub pull request, and the Azure ticket's completion-evidence field. The
`http-json`, `screen` and `command-output` evidence kinds, the capture format,
the attachment upload, the rendered HTML and Markdown documents, and the
`github-manifest-set`, `github-manifest-info` and `ticket-manifest-set` commands
go with them.

The manifest did four jobs. It acknowledged that the session had finished — now
the process exit does that. It gated the delivery by naming the issue, the
branch and the commit — the coordinator fixed the first two itself and reads the
third from git (ADR-0035). It supplied the content of a published evidence
document, and it pinned that content by digest. Only the last two were work the
coordinator could not do alone, and both existed to serve a document nobody
required: on GitHub the evidence was a self-imposed norm, and on Azure the
completion-evidence field needs text, not proof of a particular shape.

Evidence is not being weakened into a summary — it is being removed, and a
summary is what remains. Producing evidence worth reading is a separate problem
to be solved by a separate agent later; leaving the current machinery in place
until then would leave a subsystem nothing reads.

The nine remaining Azure completion gates stay (ADR-0010). `attached-capture` is
the only one removed.
