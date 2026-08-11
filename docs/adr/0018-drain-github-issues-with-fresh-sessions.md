# Drain GitHub issues with fresh sessions

`code` without `--hu` repeatedly selects and completes one eligible GitHub
issue per fresh OpenCode session, advancing only after `TICKET_COMPLETED` and
stopping after `QUEUE_EMPTY`. Both outcomes end with `WORKFLOW_STEP_FINISHED`
so the coordinator closes every provider session; the GitHub run remains
prompt-driven and independent of Azure checkpoints and adapters.
