# lazy-workflow

To install dependencies:

```bash
bun install
```

When installed globally by `install.sh --all-global` or
`install.sh --claude-global`, use the `lazy-workflow` command directly:

```bash
lazy-workflow plan --hu 23438 --working-directory /path/to/repository
lazy-workflow hu-branch-info --hu 23438
```

OpenCode events and periodic no-output heartbeats are printed with local
`dd/mm/yy HH:mm:ss` timestamps while the workflow runs. Events show their
session ID, reasoning summaries, tool status, and sanitized tool input such as
the shell command reported by OpenCode. The working directory is passed as
OpenCode's real process directory, so tools operate in the selected repository. Azure and OpenCode
retry messages are printed when a transient failure causes a retry.

The coordinator does not parse the operator prompt to choose a base branch.
OpenCode interprets that instruction and creates the HU integration branch in
the selected repository; when no base branch is specified, it uses remote
`main`, or remote `master` when `main` is unavailable.

To plan an Azure HU:

```bash
bun run main.ts plan --hu 23438 --working-directory /path/to/repository
```

Planning uses the English autoplan prompt and never implements code. Missing or
unsupported subcommands print help and do not call Azure Boards or OpenCode.

To obtain the information of a HU:

```bash
bun run main.ts hu-info --hu 23438
```

To query the HU integration branch without starting OpenCode or changing Git
or Azure:

```bash
bun run main.ts hu-branch-info --hu 23438
```

The command prints one indented JSON object with the HU number and either the
normalized native Azure Git branch (`refs/heads/...`) or `null` when no Branch
ArtifactLink exists. Malformed or multiple distinct Branch links fail with a
nonzero status; the command never proposes `hu/<HU>`.

To drain the HU's direct Task and Bug delivery tickets one at a time:

```bash
bun run main.ts code --hu 23438 --working-directory /path/to/repository
```

After `TICKET_COMPLETED`, the coordinator stops OpenCode even if its output
stream remains open and closes the native provider session with the exact
opaque session identifier. An already absent session is safe; any other
closure failure stops the run with the pinned ticket in a sessionless
checkpoint. A later invocation verifies that ticket without invoking OpenCode,
switches to the updated HU integration branch, deletes the completed ticket
branch locally and remotely, clears the checkpoint, and refreshes Azure before
starting the next eligible ticket. Branch cleanup stops safely when the
working tree contains uncommitted or untracked changes.

To recover an interrupted ticket, use the opaque session identifier printed by
OpenCode. The HU and ticket are restored from the repository checkpoint, so no
`--hu` argument is needed:

```bash
bun run main.ts code --session <session-id> --prompt continue
```

The complete command help is available with an unsupported subcommand or no
subcommand. `--model`, `--variant`, `--prompt`, and `--working-directory` are
forwarded to OpenCode; `--number-of-questions` applies to `plan`.

Autocode stores only its HU, ticket, and opaque OpenCode session in repository
Git metadata. Failed or incomplete attempts retry the same ticket every ten
seconds; the terminal marker replaces the session with `null`, and the
checkpoint is removed only after live completion verification.

If sessionless reconciliation finds incomplete Azure completion gates, it
prints the pinned ticket followed by stable reasons such as
`pinned-ticket-context`, `ticket-state`, `completion-evidence`, `real-effort`, `real-effort-hours`,
`commit-url`, `attached-capture`, `hu-integration-branch`,
`completed-hu-targeted-pr`, `native-pr-association`, or
`merge-commit-artifact-link`. The checkpoint remains intact: no OpenCode
session, branch cleanup, or later ticket is selected. Correct the reported
Azure data and rerun the same `code` command to reconcile safely; Azure
command or authentication failures remain operational errors and are not
reported as completion gates.

If OpenCode requests `az login`, lazy-workflow keeps the OpenCode session,
prints `az login --use-device-code`, waits until the HU is accessible again,
and resumes that session once with `continue`.

## Structure

```text
main.ts                 CLI entrypoint
prompts/                OpenCode prompt assets
src/azure/              Azure Boards model and service
src/cli/                Workflow coordination
src/git/                Verified ticket-branch cleanup
src/opencode/           OpenCode execution and JSONL result
test/                   Bun tests
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
