import type { LifecycleState } from "../domain/lifecycle"
import type { TrackerPort } from "../domain/ports"
import type { TrackerSelection } from "../domain/tracker"

export type HostOwnedSelectionPort = Pick<
  TrackerPort,
  "selectEligibleIssue" | "claimIssue"
>

// Session orchestration receives an identity only after selection and claim
// complete, so a worker cannot choose or switch tracker items.
export const selectAndClaimHostOwnedIssue = async (input: {
  readonly tracker: HostOwnedSelectionPort
  readonly hu?: number
  readonly baseBranch: string
  readonly currentState: LifecycleState
}): Promise<TrackerSelection> => {
  const selection = await input.tracker.selectEligibleIssue({
    hu: input.hu,
    baseBranch: input.baseBranch,
    currentState: input.currentState,
  })
  if (selection.kind === "selected") {
    await input.tracker.claimIssue({ identity: selection.identity })
  }
  return selection
}
