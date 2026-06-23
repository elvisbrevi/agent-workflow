# Reference — Per-source commands

The `afk-issuemerger` agent picks one of three sources. This file maps every operation the agent performs to the right CLI per source.

## Source detection

```bash
detect_source() {
  if gh auth status >/dev/null 2>&1 && \
     git remote -v | grep -q 'github.com'; then
    echo "github"; return
  fi
  if command -v az >/dev/null 2>&1 && \
     git remote -v | grep -q 'dev.azure.com'; then
    echo "azure"; return
  fi
  if [ -f todo.md ]; then
    echo "todo"; return
  fi
  echo "none"
}
```

## List open work

### GitHub

```bash
gh issue list \
  --state open \
  --json number,title,labels,assignees,body \
  --limit 100
```

### Azure DevOps

```bash
az boards work-item list \
  --state Active \
  --query '[].{id: id, title: fields."System.Title", state: fields."System.State", body: fields."System.Description", tags: fields."System.Tags", assignedTo: fields."System.AssignedTo"}'
```

### todo.md

```bash
# Lines like:  - [ ] #42 Implement login flow
grep -n '^- \[ \]' todo.md
```

## Filter blockers

For each candidate from the list above, skip if **any** of:

- `labels` (or `tags`) contains: `blocked`, `wip`, `do-not-implement`, `needs-design`, OR a `parent:<N>` label where `<N>` is still open.
- `assignees` (or `assignedTo`) is non-empty.
- `body` matches regex `Blocked by:\s*#(\d+)` and that issue is still open.
- Title starts with `[skip]` or contains `<!-- skip -->`.

For todo.md, "labels" are inline tags in the line. A common convention:

```
- [ ] #42 Implement login flow  #blocked  #needs-design
```

Skip if any of these tags appear in the line.

## Filter HITL (stop the entire loop)

- Labels/tags: `hitl`, `needs-human`, `requires-human`, `design-review`
- Body matches: `requires human`, `needs design`, `awaiting decision`

If **all remaining items are HITL** (or all blocked), the loop exits — do not pick any.

## Detect "Blocked by" targets

For GitHub:

```bash
# Given body of issue N, extract blocked-by numbers
gh issue view <N> --json body --jq '.body' | \
  grep -oP 'Blocked by:\s*#\K\d+'
```

For Azure, the `Blocked by` relation is a native link, not a body string. Use:

```bash
az boards work-item relation list --id <N> --relation-type Parent
```

For todo.md, the convention is: `- [ ] #42 ...  #blocked-by:#41`. Use `grep -oP 'blocked-by:#\K\d+'`.

For each extracted number, check if that issue is still open with the same list commands above.

## Close on success

### GitHub

```bash
SHA=$(git rev-parse HEAD)
gh issue close <N> --comment "Merged in ${SHA} by afk-issuemerger"
```

### Azure DevOps

```bash
SHA=$(git rev-parse HEAD)
az boards work-item update \
  --id <N> \
  --state Closed \
  --discussion "Merged in ${SHA} by afk-issuemerger"
```

### todo.md

```bash
# Find the line number for issue N, then toggle its checkbox
LINE=$(grep -n "^- \[ \] #${N}\b" todo.md | head -1 | cut -d: -f1)
[ -n "$LINE" ] && sed -i "${LINE}s/- \[ \]/- [x]/" todo.md
```

## Comment on failure

### GitHub

```bash
gh issue comment <N> --body "⚠️ afk-issuemerger could not converge after ${ISSUE_RUNNER_MAX_RETRIES:-5} retries. Branch feat/issue-<N> left for review."
```

### Azure DevOps

```bash
az boards work-item update \
  --id <N> \
  --discussion "⚠️ afk-issuemerger could not converge after ${ISSUE_RUNNER_MAX_RETRIES:-5} retries. Branch feat/issue-<N> left for review."
```

### todo.md

```bash
# Append a failure note as a comment under the task
LINE=$(grep -n "^- \[ \] #${N}\b" todo.md | head -1 | cut -d: -f1)
[ -n "$LINE" ] && sed -i "${LINE}a\\
  > ⚠️ afk-issuemerger could not converge — branch feat/issue-<N> needs review" todo.md
```

## Conflict handling

If `git merge --squash feat/issue-<N>` fails with a conflict (because the base branch moved during work):

```bash
git merge --abort
# Leave feat/issue-<N> alive
# Comment on the issue: "Merge conflict on ${BASE_BRANCH}. Branch feat/issue-<N> left for resolution."
# /clear and continue to the next iteration
```

## Authentication prerequisites

Before launching, ensure:

- **GitHub**: `gh auth login` completed. The default protocol is `https`.
- **Azure DevOps**: `az login` completed. The default org is read from `git remote -v`.
- **`todo.md`**: write permission to the file (the agent will edit it).
- **Git**: push access to the base branch. The agent will not prompt for credentials mid-loop.
