/** Formatting for the readouts.  Fixed width, so digits do not jump.
 *
 *  The numbers on a rate line span very different sizes -- a trigger rate of a
 *  few hundred per second, a buffer occupancy of a fraction of a percent, and a
 *  trigger count that reaches tens of millions on an overnight run -- so the
 *  channel decides how it is written rather than one rule covering all four.
 */

import type { ChannelKey, Holder } from "./types"

/** Significant digits shown wherever a measured value appears. */
const SIGNIFICANT = 4

export function formatValue(value: number | null | undefined, digits = SIGNIFICANT): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (value === 0) return "0"
  const size = Math.abs(value)
  // A trigger count in the millions is a count, not a measurement; past that
  // it is easier to read as an exponent than as eight digits.
  if (size >= 1e9 || size < 1e-3) return value.toExponential(digits - 1)
  if (size >= 1000) return Math.round(value).toLocaleString("en-US")
  return String(Number(value.toPrecision(digits)))
}

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return Math.round(value).toLocaleString("en-US")
}

/** The one place a channel's own convention is written down. */
export function formatChannel(key: ChannelKey, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  // Triggers are counted, not measured: every digit is real and rounding one
  // away would make two different totals look like the same total.
  if (key === "total_intr") return formatCount(value)
  // Occupancy is printed by the board to two decimals, and the difference
  // between 0.00 % and 0.03 % is the difference between empty and filling.
  if (key === "mem_pct") return value.toFixed(2)
  return formatValue(value)
}

/**
 * For a chart's y axis, where the ticks must read as a scale, not as data.
 *
 * Takes null, and must: uPlot hands a hidden tick back as `null`, and a
 * formatter that assumes a number throws in the middle of its canvas draw --
 * where no React error boundary can catch it and the chart simply stops
 * appearing.
 */
export function formatTick(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ""
  if (value === 0) return "0"
  const size = Math.abs(value)
  // k and M on the axis only. An overnight trigger count runs to eight
  // digits, and eight digits at every gridline is a wall of numbers.
  if (size >= 1e6) return `${Number((value / 1e6).toPrecision(3))}M`
  if (size >= 1e4) return `${Number((value / 1e3).toPrecision(3))}k`
  return String(Number(value.toPrecision(4)))
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—"
  if (bytes < 1024) return `${bytes} B`
  const units = ["kB", "MB", "GB", "TB"]
  let size = bytes / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[index]}`
}

/** "minicom (pid 2526930, found by its lock file)" -- who has a port. */
export function describeHolder(holder: Holder): string {
  const how = holder.via === "lock file" ? ", found by its lock file" : ""
  return `${holder.name} (pid ${holder.pid}${how})`
}
