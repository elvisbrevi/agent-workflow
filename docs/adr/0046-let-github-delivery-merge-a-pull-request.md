---
status: accepted
---

# Let a GitHub delivery session merge a pull request

The `lazy-github-code` profile denied every `gh pr` subcommand, because opening
and merging the unit's pull request is a delivery effect the coordinator owns
(ADR-0020, ADR-0021). The operator now wants a GitHub delivery session to be able
to run `gh pr merge`, and asked for exactly that command.

The profile therefore denies each `gh pr` subcommand by name — with the aliases
`co`, `new` and `ls`, and the `-R`/`--repo` spellings that would otherwise reach
any of them first — and leaves `merge` out. It cannot be written as one blanket
deny plus an allow: Claude Code lets a deny win over any allow, and Codex
execpolicy takes the strictest matching decision, so the exception only exists
where nothing denies it. The three formats list the same subcommands, and a test
pins each of them.

Nothing else moves. The coordinator still pushes the unit's branch, opens its
pull request, merges it after session verification and closes the issue; `gh
api`, `gh repo` and pushing stay denied, so a session cannot reach a merge any
other way. The Azure profiles still deny all of `gh`, and the planning profile
still denies `gh pr`.

Separately, the repository's own `.claude/settings.json` allows `gh pr merge` for
the Claude Code sessions that maintain this repository. That rule governs this
checkout, not any lazy-workflow run.
