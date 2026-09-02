---
status: accepted
---

# Default the model per coding agent CLI

`--model` defaults to a model of the selected `--cli` rather than to one global
value. The single default was written when OpenCode was the only CLI, and it is
an OpenCode model identifier: naming any other CLI without `--model` opens a
session against a model that CLI cannot resolve, so the failure arrives from the
provider mid-run instead of from the flag that caused it. A third CLI turns that
from one awkward case into the normal one.

The default is therefore resolved after `--cli`, from the same table that already
maps a CLI to its binary and its accepted efforts. An explicitly supplied
`--model` still wins, and a fallback rung keeps declaring its model in full,
because a rung names its provider and its account together and has no default to
inherit.

The alternative — keeping one visible default and letting the operator discover
the mismatch — was rejected for the reason ADR-0024 verifies rung binaries while
parsing: a resolution error that can be raised before any usage is spent should
be.

`--variant` needs no equivalent change. Its default, `high`, is an effort every
CLI accepts, and one already validated per CLI.
