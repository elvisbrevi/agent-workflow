export type CleanupHook = () => Promise<void> | void

export type SignalEvent = {
  readonly signal: NodeJS.Signals | "manual"
}

export type SignalEventListener = (event: SignalEvent) => void

export type SignalCoordinatorOptions = {
  readonly signals?: ReadonlyArray<NodeJS.Signals>
  readonly abortController?: AbortController
  readonly installHandlers?: boolean
  readonly emitter?: SignalEmitter
}

export type SignalEmitter = {
  addListener(listener: SignalEventListener): () => void
  emit(event: SignalEvent): void
}

const DEFAULT_SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"]

export const nodeSignalEmitter = (
  signals: ReadonlyArray<NodeJS.Signals> = DEFAULT_SIGNALS,
): SignalEmitter => {
  const listeners = new Set<SignalEventListener>()
  const handlers: Array<{ readonly signal: NodeJS.Signals; readonly handler: NodeJS.SignalsListener }> = []
  for (const signal of signals) {
    const handler = (sig: NodeJS.Signals): void => {
      for (const listener of listeners) {
        try {
          listener({ signal: sig })
        } catch {
          // listener failures must not propagate
        }
      }
    }
    process.on(signal, handler)
    handlers.push({ signal, handler })
  }
  return {
    addListener(listener: SignalEventListener): () => void {
      listeners.add(listener)
      return (): void => {
        listeners.delete(listener)
      }
    },
    emit(event: SignalEvent): void {
      for (const listener of listeners) {
        listener(event)
      }
    },
  }
}

export class CleanupHookError extends Error {
  readonly hookIndex: number
  readonly cause: unknown

  constructor(hookIndex: number, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(`cleanup hook #${hookIndex} failed: ${message}`)
    this.name = "CleanupHookError"
    this.hookIndex = hookIndex
    this.cause = cause
  }
}

export type SignalCoordinator = {
  readonly signal: AbortSignal
  readonly reason: string
  readonly cleanup: () => Promise<void>
  registerHook(hook: CleanupHook): () => void
  dispose(): void
}

const orderHooks = (hooks: ReadonlyArray<CleanupHook>): ReadonlyArray<CleanupHook> => {
  const reversed: CleanupHook[] = []
  for (let index = hooks.length - 1; index >= 0; index -= 1) {
    const hook = hooks[index]
    if (hook !== undefined) {
      reversed.push(hook)
    }
  }
  return reversed
}

export const createSignalCoordinator = (
  options: SignalCoordinatorOptions = {},
): SignalCoordinator => {
  const controller = options.abortController ?? new AbortController()
  const hooks: CleanupHook[] = []
  let abortedReason: string | null = null
  let disposed = false

  const unsubscribe = options.emitter
    ? options.emitter.addListener((event) => {
        if (abortedReason !== null) {
          return
        }
        abortedReason = `signal: ${event.signal}`
        controller.abort(abortedReason)
      })
    : null

  const handleInstall = options.installHandlers ?? true
  let runtimeUnsubscribe: (() => void) | null = null
  if (handleInstall && options.emitter === undefined && typeof process === "object") {
    const runtimeEmitter = nodeSignalEmitter(options.signals ?? DEFAULT_SIGNALS)
    runtimeUnsubscribe = runtimeEmitter.addListener((event) => {
      if (abortedReason !== null) {
        return
      }
      abortedReason = `signal: ${event.signal}`
      controller.abort(abortedReason)
    })
  }

  const cleanup = async (): Promise<void> => {
    const ordered = orderHooks(hooks)
    for (let index = 0; index < ordered.length; index += 1) {
      const hook = ordered[index]
      if (hook === undefined) {
        continue
      }
      try {
        await hook()
      } catch (error) {
        const originalIndex = hooks.length - 1 - index
        throw new CleanupHookError(originalIndex, error)
      }
    }
  }

  const registerHook = (hook: CleanupHook): (() => void) => {
    if (disposed) {
      throw new Error("signal coordinator disposed; cannot register new hook")
    }
    hooks.push(hook)
    let removed = false
    return (): void => {
      if (removed) {
        return
      }
      removed = true
      const index = hooks.indexOf(hook)
      if (index >= 0) {
        hooks.splice(index, 1)
      }
    }
  }

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    if (unsubscribe !== null) {
      unsubscribe()
    }
    if (runtimeUnsubscribe !== null) {
      runtimeUnsubscribe()
    }
    hooks.length = 0
  }

  return {
    signal: controller.signal,
    get reason(): string {
      return abortedReason ?? "unsignaled"
    },
    cleanup,
    registerHook,
    dispose,
  }
}
