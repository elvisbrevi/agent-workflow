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

export type SystemClockInput = {
  readonly now?: () => Date
}

export const systemClock = (input?: SystemClockInput): ClockPort => {
  const source = input?.now ?? ((): Date => new Date())
  return {
    now: (): string => formatTimestamp(source()),
  }
}

export const SYSTEM_CLOCK_NOW: ClockPort = systemClock()

export const formatTimestampForTest = formatTimestamp