---
status: superseded by ADR-0018
---

# Default to GitHub without an HU

The absence of `--hu` selects a one-shot GitHub repository run driven by the
default workflow prompt, without Azure tools, checkpoints, branch preflight,
or completion gates. Supplying `--hu`, or resuming an Azure checkpoint with
`code --session`, selects the existing Azure HU run; this explicit split keeps
provider-specific lifecycles separate instead of introducing a shared tracker
abstraction.
