# Autonomous Issue Execution

This context describes the language used to configure and run an autonomous worker that completes tracker issues.

## Language

**Execution profile**:
A named, validated pairing of one agent CLI with one model and the runtime behavior they require. Profiles are selected as indivisible options rather than assembled from independent CLI and model choices.
_Avoid_: Agent configuration, CLI/model combination

**Fallback chain**:
An ordered list of alternative **execution profiles** that may continue the same issue after an eligible provider failure. A chain contains only OpenCode profiles and ends when no alternatives remain or the operator selects none.
_Avoid_: Backup model, model rotation

## Example Dialogue

Developer: "Which execution profile should issue-killer use?"

Operator: "Use the Codex profile with the high-reasoning GPT model."

Developer: "What happens if that OpenCode provider reaches its subscription limit?"

Operator: "Continue the issue with the next execution profile in its fallback chain."
