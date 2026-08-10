# lazy-workflow

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run main.ts --hu 23438 --working-directory /path/to/repository
```

To obtain the information of a HU:

```bash
bun run main.ts hu-info --hu 23438
```

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
