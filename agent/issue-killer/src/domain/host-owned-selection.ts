import type { LifecycleState } from "./lifecycle"
import type { SessionId } from "./session-id"
import type { TrackerIdentity, TrackerKind } from "./tracker"
import { identityLabel } from "./tracker"

export type SelectionContext = {
  readonly hostOwned: true
  readonly repository: string
  readonly tracker: TrackerKind
  readonly hu?: number
  readonly baseBranch: string
  readonly currentState: LifecycleState
}

export const buildSelectionContext = (input: {
  readonly repository: string
  readonly tracker: TrackerKind
  readonly hu?: number
  readonly baseBranch: string
  readonly currentState: LifecycleState
}): SelectionContext => ({
  hostOwned: true,
  repository: input.repository,
  tracker: input.tracker,
  hu: input.hu,
  baseBranch: input.baseBranch,
  currentState: input.currentState,
})

export type HostOwnedIdentity =
  | { readonly source: "supervisor"; readonly identity: TrackerIdentity }
  | { readonly source: "adoption"; readonly identity: TrackerIdentity; readonly raw: string }
  | { readonly source: "checkpoint"; readonly identity: TrackerIdentity; readonly sessionId: SessionId }

export const hostOwnedIdentityLabel = (host: HostOwnedIdentity): string => {
  switch (host.source) {
    case "supervisor":
      return `supervisor pinned ${identityLabel(host.identity)}`
    case "adoption":
      return `adoption ${host.raw} → ${identityLabel(host.identity)}`
    case "checkpoint":
      return `checkpoint ${identityLabel(host.identity)} session ${host.sessionId}`
    default: {
      const exhaustive: never = host
      throw new Error(`unhandled host-owned identity: ${(exhaustive as { source: string }).source}`)
    }
  }
}

export type HostOwnedDecision =
  | { readonly kind: "use_supervisor"; readonly identity: TrackerIdentity }
  | { readonly kind: "use_adoption"; readonly identity: TrackerIdentity; readonly raw: string }
  | { readonly kind: "use_checkpoint"; readonly identity: TrackerIdentity; readonly sessionId: SessionId }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<TrackerIdentity> }
  | { readonly kind: "none" }

export const decideHostOwned = (input: {
  readonly supervisorIdentity?: TrackerIdentity
  readonly adoptionRaw?: string
  readonly checkpointIdentity?: TrackerIdentity
  readonly checkpointSession?: SessionId
  readonly parsedAdoption?: { readonly kind: "ok"; readonly identity: TrackerIdentity }
}): HostOwnedDecision => {
  const sources: ReadonlyArray<TrackerIdentity> = [
    ...(input.supervisorIdentity !== undefined ? [input.supervisorIdentity] : []),
    ...(input.parsedAdoption !== undefined ? [input.parsedAdoption.identity] : []),
    ...(input.checkpointIdentity !== undefined ? [input.checkpointIdentity] : []),
  ]
  const unique: TrackerIdentity[] = []
  for (const identity of sources) {
    if (!unique.some((existing) => identityEquals(existing, identity))) {
      unique.push(identity)
    }
  }
  if (unique.length === 0) {
    return { kind: "none" }
  }
  if (unique.length > 1) {
    return { kind: "ambiguous", candidates: unique }
  }
  const identity = unique[0]
  if (identity === undefined) {
    return { kind: "none" }
  }
  if (input.supervisorIdentity !== undefined && identityEquals(identity, input.supervisorIdentity)) {
    return { kind: "use_supervisor", identity }
  }
  if (input.parsedAdoption !== undefined && identityEquals(identity, input.parsedAdoption.identity)) {
    if (input.adoptionRaw === undefined) {
      return { kind: "none" }
    }
    return { kind: "use_adoption", identity, raw: input.adoptionRaw }
  }
  if (input.checkpointIdentity !== undefined && identityEquals(identity, input.checkpointIdentity)) {
    if (input.checkpointSession === undefined) {
      return { kind: "none" }
    }
    return { kind: "use_checkpoint", identity, sessionId: input.checkpointSession }
  }
  return { kind: "use_supervisor", identity }
}

export const identityEquals = (left: TrackerIdentity, right: TrackerIdentity): boolean => {
  if (left.kind !== right.kind) {
    return false
  }
  switch (left.kind) {
    case "github":
      return right.kind === "github" && left.number === right.number
    case "azure_ticket":
      return (
        right.kind === "azure_ticket" && left.hu === right.hu && left.ticket === right.ticket
      )
    default: {
      const exhaustive: never = left
      throw new Error(`unhandled tracker identity kind: ${(exhaustive as { kind: string }).kind}`)
    }
  }
}
