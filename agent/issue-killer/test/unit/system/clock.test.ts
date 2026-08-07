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
})