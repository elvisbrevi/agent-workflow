import { describe, expect, test } from "bun:test"
import {
  CleanupHookError,
  createSignalCoordinator,
  nodeSignalEmitter,
  type SignalEvent,
  type SignalEmitter,
} from "../../../src/system/signals"

const flushAsync = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe("createSignalCoordinator", () => {
  test("does not abort before any signal is emitted", () => {
    const coordinator = createSignalCoordinator({
      emitter: { addListener: () => () => undefined, emit: () => undefined },
      installHandlers: false,
    })
    expect(coordinator.signal.aborted).toBe(false)
    expect(coordinator.reason).toBe("unsignaled")
    coordinator.dispose()
  })

  test("aborts the controller when the emitter fires", () => {
    let listener: ((event: SignalEvent) => void) | null = null
    const emitter: SignalEmitter = {
      addListener: (next): (() => void) => {
        listener = next
        return (): void => {
          listener = null
        }
      },
      emit: (event): void => {
        if (listener !== null) {
          listener(event)
        }
      },
    }
    const coordinator = createSignalCoordinator({ emitter, installHandlers: false })
    expect(coordinator.signal.aborted).toBe(false)
    emitter.emit({ signal: "SIGINT" })
    expect(coordinator.signal.aborted).toBe(true)
    expect(coordinator.reason).toBe("signal: SIGINT")
    coordinator.dispose()
  })

  test("runs registered cleanup hooks in reverse registration order", async () => {
    const order: number[] = []
    const coordinator = createSignalCoordinator({
      emitter: { addListener: () => () => undefined, emit: () => undefined },
      installHandlers: false,
    })
    coordinator.registerHook(() => {
      order.push(1)
    })
    coordinator.registerHook(async () => {
      order.push(2)
    })
    coordinator.registerHook(() => {
      order.push(3)
    })
    await coordinator.cleanup()
    expect(order).toEqual([3, 2, 1])
    coordinator.dispose()
  })

  test("wraps the first failing cleanup hook in a CleanupHookError", async () => {
    const coordinator = createSignalCoordinator({
      emitter: { addListener: () => () => undefined, emit: () => undefined },
      installHandlers: false,
    })
    coordinator.registerHook(() => undefined)
    coordinator.registerHook(() => {
      throw new Error("boom")
    })
    coordinator.registerHook(() => undefined)
    await expect(coordinator.cleanup()).rejects.toBeInstanceOf(CleanupHookError)
    coordinator.dispose()
  })

  test("does not run new hooks after disposal", async () => {
    const coordinator = createSignalCoordinator({
      emitter: { addListener: () => () => undefined, emit: () => undefined },
      installHandlers: false,
    })
    coordinator.dispose()
    expect(() => coordinator.registerHook(() => undefined)).toThrow(
      /signal coordinator disposed/,
    )
  })

  test("unsubscribes the emitter listener on dispose", () => {
    let active = 0
    const emitter: SignalEmitter = {
      addListener: (listener): (() => void) => {
        active += 1
        return (): void => {
          active -= 1
        }
      },
      emit: (): void => undefined,
    }
    const coordinator = createSignalCoordinator({ emitter, installHandlers: false })
    expect(active).toBe(1)
    coordinator.dispose()
    expect(active).toBe(0)
  })
})

describe("nodeSignalEmitter", () => {
  test("registers listeners that fire when the emitter broadcasts", () => {
    const emitter = nodeSignalEmitter([])
    const received: SignalEvent[] = []
    emitter.addListener((event) => {
      received.push(event)
    })
    emitter.emit({ signal: "manual" })
    emitter.emit({ signal: "SIGTERM" })
    expect(received.map((event) => event.signal)).toEqual(["manual", "SIGTERM"])
  })

  test("removes a listener when its unsubscribe function is called", () => {
    const emitter = nodeSignalEmitter([])
    const received: SignalEvent[] = []
    const unsubscribe = emitter.addListener((event) => {
      received.push(event)
    })
    emitter.emit({ signal: "SIGINT" })
    unsubscribe()
    emitter.emit({ signal: "SIGTERM" })
    expect(received.map((event) => event.signal)).toEqual(["SIGINT"])
  })
})

describe("createSignalCoordinator with AbortSignal coordination", () => {
  test("propagates a manual abort through the underlying controller", async () => {
    const controller = new AbortController()
    const coordinator = createSignalCoordinator({
      emitter: { addListener: () => () => undefined, emit: () => undefined },
      installHandlers: false,
      abortController: controller,
    })
    const aborted = new Promise<void>((resolve) => {
      coordinator.signal.addEventListener("abort", () => resolve(), { once: true })
    })
    controller.abort("operator")
    await aborted
    expect(coordinator.signal.aborted).toBe(true)
    expect(coordinator.reason).toBe("unsignaled")
    coordinator.dispose()
    await flushAsync()
  })
})
