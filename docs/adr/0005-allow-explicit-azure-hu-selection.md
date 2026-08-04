# Allow explicit Azure HU selection

Azure runs may accept an optional `--hu <ID>` that pins execution to one validated delivery HU and its eligible direct-child tickets; without it, the runner discovers the next prepared HU. GitHub runs reject this Azure-specific option. Checkpoints preserve both HU and child-ticket identity so retries and restarts cannot silently move to another HU or ticket.
