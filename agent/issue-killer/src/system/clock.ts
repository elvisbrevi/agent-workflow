import type { ClockPort } from "../domain/ports"

const formatTimestamp = (date: Date): string => {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0")
  const year = date.getUTCFullYear()
  const month = pad(date.getUTCMonth() + 1)
  const day = pad(date.getUTCDate())
  const hour = pad(date.getUTCHours())
  const minute = pad(date.getUTCMinutes())
  const second = pad(date.getUTCSeconds())
  const offsetMinutes = -date.getTimezoneOffset()
  const offsetSign = offsetMinutes >= 0 ? "+" : "-"
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60))
  const offsetMins = pad(Math.abs(offsetMinutes) % 60)
  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${offsetSign}${offsetHours}${offsetMins}`
}

export type SystemSleepFn = (input: { readonly millis: number; readonly signal?: AbortSignal }) => Promise<void>

export type SystemClockInput = {
  readonly now?: () => Date
  readonly sleep?: SystemSleepFn
}

const defaultSleep: SystemSleepFn = ({ millis, signal }) =>
  new Promise<void>((resolve, reject) => {
    if (millis < 0) {
      reject(new Error(`sleep millis must be non-negative; received ${millis}`))
      return
    }
    if (signal?.aborted === true) {
      reject(new Error("sleep aborted"))
      return
    }
    const handle = setTimeout(() => {
      resolve()
    }, millis)
    if (typeof handle.unref === "function") {
      handle.unref()
    }
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(handle)
        reject(new Error("sleep aborted"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })

export const systemClock = (input?: SystemClockInput): ClockPort => {
  const source = input?.now ?? ((): Date => new Date())
  const sleep = input?.sleep ?? defaultSleep
  return {
    now: (): string => formatTimestamp(source()),
    sleep: async ({ millis, signal }): Promise<void> => {
      await sleep({ millis, signal })
    },
  }
}

export const SYSTEM_CLOCK_NOW: ClockPort = systemClock()

export const formatTimestampForTest = formatTimestamp
