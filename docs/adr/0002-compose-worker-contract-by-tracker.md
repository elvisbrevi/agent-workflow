# Compose the worker contract by tracker

`issue-killer` will build each worker prompt from one shared contract plus a tracker-specific contract for GitHub or Azure DevOps. This preserves common implementation, review, safety, recovery, and status rules while allowing the trackers to have different execution units, branch targets, completion criteria, and lifecycle effects without maintaining two nearly identical full prompts.
