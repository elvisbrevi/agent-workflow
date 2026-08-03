# Domain Docs

This repository uses a single-context domain layout. Engineering skills should read the domain documentation relevant to their work before exploring or changing the codebase.

## Sources

- `CONTEXT.md` defines the canonical domain vocabulary.
- `docs/adr/` records architectural decisions.

If either source is absent, proceed silently. Domain documentation is created lazily when terms or decisions are resolved.

## Consumer Rules

- Use terms exactly as defined in `CONTEXT.md`; avoid synonyms it rejects.
- Read ADRs that affect the area being changed.
- Surface conflicts with an ADR instead of silently overriding it.
- Treat a missing term as a prompt to reconsider the language or invoke domain modeling, not as permission to invent competing vocabulary.
