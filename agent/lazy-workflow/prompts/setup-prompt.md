Prepare this machine so lazy-workflow (`lz`) can run `plan` and `code` against
the GitHub repositories and Azure DevOps projects the operator works with.
Fix only the configuration problems listed below, and anything they directly
depend on. Do not plan, implement, commit, push, or change any tracker item.

Use the `lz` and `credentials` skills: they document how lz reads its stored
environment (`lz credentials-status`, `lz credentials-set`), which tools it
needs, and how each one is authenticated. Check before you change anything,
and check again afterwards with the same command, so the report says what is
verified rather than what was attempted.

Never print, echo, or write a secret value into a file, a command line, or
your report. When a fix needs something only the operator has — a token, a
password, a browser login, a device code, a `sudo` password — do not invent
it and do not wait for it: leave that step for the operator.

End with a short report in Spanish, one line per problem: `✓` when it is
fixed and verified, `✗` when it still needs the operator, followed by the
exact command or action the operator must take.
