import { describe, expect, test } from "bun:test"
import { SYSTEM_CLOCK_NOW, formatTimestampForTest, systemClock } from "../../../src/system/clock"

describe("formatTimestampForTest", () => {
  test("formats UTC dates deterministically", () => {
    const fixed = new Date("2026-08-06T10:30:45.123Z")
    expect(formatTimestampForTest(fixed)).toMatch(/^2026-08-06 10:30:45 [+-]\d{4}$/)
  })
})

describe("systemClock", () => {
  test("delegates to the provided source and returns a deterministic timestamp", () => {
    const fixed = new Date("2026-08-06T10:30:45Z")
    const clock = systemClock({ now: () => fixed })
    expect(clock.now()).toMatch(/^2026-08-06 10:30:45 [+-]\d{4}$/)
  })

  test("SYSTEM_CLOCK_NOW exposes a non-empty timestamp", () => {
    const value = SYSTEM_CLOCK_NOW.now()
    expect(value.length).toBeGreaterThan(0)
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/)
  })

  test("sleep uses the injected sleep function", async () => {
    let calls = 0
    const clock = systemClock({
      sleep: async () => {
        calls += 1
      },
    })
    await clock.sleep({ millis: 5 })
    expect(calls).toBe(1)
  })

  test("default sleep resolves after the requested delay", async () => {
    const clock = systemClock()
    const started = Date.now()
    await clock.sleep({ millis: 25 })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(20)
  })

  test("default sleep rejects when the signal aborts before the timer fires", async () => {
    const clock = systemClock()
    const controller = new AbortController()
    const promise = clock.sleep({ millis: 1_000, signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toThrow(/aborted/)
  })

  test("default sleep rejects negative durations immediately", async () => {
    const clock = systemClock()
    await expect(clock.sleep({ millis: -1 })).rejects.toThrow(/non-negative/)
  })
})
