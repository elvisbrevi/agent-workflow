/**
 * The one clock format the operator reads. Every reported line carries it, so a
 * run that took hours can be read back knowing when each step happened, and the
 * reporter and the operator helpers never drift into two different formats.
 */

const pad = (value: number): string => value.toString().padStart(2, "0");

/** Local `dd/mm/yy HH:mm:ss`, the width the reporter aligns its gutter against. */
export function formatOperatorTimestamp(date = new Date()): string {
  return [
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${pad(date.getFullYear() % 100)}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

/** Every timestamp renders at this width, so continuation lines can be padded to it. */
export const OPERATOR_TIMESTAMP_WIDTH = "dd/mm/yy HH:mm:ss".length;
