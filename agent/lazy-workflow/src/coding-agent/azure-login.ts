/**
 * The `az login` handshake as it appears in a coding agent's stream. Both CLIs
 * ask for the same thing in the same two ways — a shell call that runs it, or a
 * message that asks the operator to — so the recognition lives once here and the
 * adapters only decide which of their own events to read it from (ADR-0023).
 */

const loginInstructionPattern = /(?:please\s+run|run|ejecuta|execute).{0,40}\baz\s+login\b/i;
const loginCommandPattern = /(?:^|[;&|]\s*)az\s+login\b/i;

/** Text that asks the operator to authenticate, wherever the CLI emitted it. */
export function asksForAzureLogin(text: string): boolean {
  return loginInstructionPattern.test(text);
}

/** A shell command the session itself tried to run to authenticate. */
export function runsAzureLogin(command: string): boolean {
  return loginCommandPattern.test(command);
}
