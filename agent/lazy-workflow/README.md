# lazy-workflow

To install dependencies:

```bash
bun install
```

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

To deliver one ticket and recover an interrupted session:

```bash
bun run main.ts code --hu 23438 --working-directory /path/to/repository
bun run main.ts code --session <session-id> --prompt continue
```

Autocode stores only its HU, ticket, and opaque OpenCode session in repository
Git metadata. Failed or incomplete attempts retry the same ticket every ten
seconds; the checkpoint is removed only after live completion verification.

If OpenCode requests `az login`, lazy-workflow keeps the OpenCode session,
prints `az login --use-device-code`, waits until the HU is accessible again,
and resumes that session once with `continue`.

## Structure

```text
main.ts                 CLI entrypoint
prompts/                OpenCode prompt assets
src/azure/              Azure Boards model and service
src/cli/                Workflow coordination
src/opencode/           OpenCode execution and JSONL result
test/                   Bun tests
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
