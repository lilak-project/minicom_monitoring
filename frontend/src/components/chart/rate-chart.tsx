import { useEffect, useMemo, useRef } from "react"
import type uPlot from "uplot"

import { formatChannel, formatTick } from "@/lib/format"
import { useTheme } from "@neon"
import { axisColor, chartFont, gridColor, seriesColor, surfaceColor, tickColor } from "@/lib/palette"
import { formatClock } from "@/lib/time"
import type { SeriesChannel } from "@/lib/types"

import { toAligned } from "./chart-data"
import type { TimeWindow } from "./use-time-range"
import { UplotChart } from "./uplot-react"
import { zoomPlugin } from "./zoom-plugin"


/** The mean is drawn, not just written: grey and dashed, so it reads as a
 *  reference rather than as a fifth measurement. */

/** How a time tick is written depends on how much of the axis it has to place.
 *
 *  Every formatter here takes null, for the same reason `formatTick` does: an
 *  axis may hand back a hidden tick as null, and throwing inside uPlot's draw
 *  takes the chart with it. */
function timeTicks(span: number) {
  const blank = (value: number | null | undefined): value is null =>
    value == null || !Number.isFinite(value)

  if (span <= 300) return (value: number | null) => (blank(value) ? "" : formatClock(value, true))
  if (span <= 3 * 3600)
    return (value: number | null) => (blank(value) ? "" : formatClock(value, false))
  if (span <= 3 * 86400) {
    return (value: number | null) => {
      if (blank(value)) return ""
      const date = new Date(value * 1000)
      const midnight = date.getHours() === 0 && date.getMinutes() === 0
      // A day boundary is the one tick worth naming: it says which night the
      // gap on the left belongs to.
      return midnight ? `${date.getMonth() + 1}/${date.getDate()}` : formatClock(value, false)
    }
  }
  return (value: number | null) => {
    if (blank(value)) return ""
    const date = new Date(value * 1000)
    return `${date.getMonth() + 1}/${date.getDate()}`
  }
}

/**
 * One quantity off the rate line, against the clock, with its mean across it.
 *
 * One y scale, always. The four numbers on a rate line are in four different
 * units -- triggers a second, megabits a second, a percentage, a count -- and
 * putting two of them on one axis would make them look comparable when they
 * are not on the same scale at all. So the chart shows one at a time and the
 * picker above it says which.
 *
 * The mean line is the point of the chart as much as the trace is: a trigger
 * rate that swings between 600 and 1200 has no readable "current" value, and
 * the number people actually quote is the average over the window they are
 * looking at. Drawing it means the reader can see how much of the run sits
 * above and below it rather than taking the number on faith.
 */
export function RateChart({
  channels,
  window,
  mean,
  zeroFloor = true,
  height = 240,
  loading = false,
  onRange,
  onReset,
  onPlot,
}: {
  channels: SeriesChannel[]
  window: TimeWindow
  /** Mean over every sample in the window, or null not to draw one. */
  mean: number | null
  /** Start the y axis at zero.  False for a count that never goes near it. */
  zeroFloor?: boolean
  height?: number
  loading?: boolean
  onRange: (from: number, to: number) => void
  onReset: () => void
  /** Handed the plot once it exists, so the card can export its canvas. */
  onPlot?: (plot: uPlot) => void
}) {
  const plotRef = useRef<uPlot | null>(null)
  const windowRef = useRef(window)
  windowRef.current = window
  const spanRef = useRef(window.to - window.from)
  spanRef.current = window.to - window.from

  const showMean = mean != null && Number.isFinite(mean)

  const data = useMemo(() => {
    const aligned = toAligned(channels)
    if (!showMean) return aligned
    const times = aligned[0] as number[]
    // A flat series rather than a plugin: it lands in the legend beside the
    // trace, so the cursor reads the mean and the value at once.
    return [...aligned, times.map(() => mean)] as unknown as uPlot.AlignedData
  }, [channels, mean, showMean])

  const unit = channels[0]?.unit ?? ""
  const key = channels[0]?.key
  // Canvas colours are read when the chart is built, so a theme change rebuilds it.
  const theme = useTheme()
  // Everything uPlot cannot be told after it is built. The mean's *value*
  // changes with every window and must not be in here -- only whether there
  // is one, which changes how many series the plot has.
  const rebuildKey = useMemo(
    () =>
      [
        zeroFloor ? "zero" : "auto",
        showMean ? "mean" : "no-mean",
        channels.map((channel) => `${channel.key}/${channel.unit}`).join("|"),
        theme,
      ].join("~"),
    [zeroFloor, showMean, channels, theme],
  )

  const options = useMemo<Omit<uPlot.Options, "width" | "height">>(
    () => ({
      cursor: {
        // uPlot draws the selection; the zoom plugin decides what it means, so
        // a drag can go back to the server for the samples inside it.
        drag: { x: true, y: false, setScale: false },
        points: { size: 8 },
      },
      // Live values at the crosshair, for the trace and the mean at once. It
      // is the legend and the tooltip in one.
      legend: { live: true, markers: { width: 3 } },
      scales: {
        x: { time: true, auto: false },
        y: {
          // A trigger rate starts at zero and a stopped run reads zero; an
          // axis that floated off the floor would hide exactly that. A trigger
          // *count* never goes near zero mid-run, so it is left to auto-scale.
          auto: true,
          ...(zeroFloor
            ? { range: (_self: uPlot, _min: number, max: number) => [0, max > 0 ? max * 1.05 : 1] }
            : {}),
        },
      },
      axes: [
        {
          stroke: axisColor(),
          font: chartFont(),
          grid: { stroke: gridColor(), width: 1 },
          ticks: { stroke: tickColor(), width: 1, size: 5 },
          values: (_self: uPlot, splits: number[]) => splits.map(timeTicks(spanRef.current)),
        },
        {
          scale: "y",
          label: unit,
          labelFont: chartFont(),
          stroke: axisColor(),
          font: chartFont(),
          size: 68,
          grid: { stroke: gridColor(), width: 1 },
          ticks: { stroke: tickColor(), width: 1, size: 5 },
          values: (_self: uPlot, splits: number[]) => splits.map(formatTick),
        },
      ],
      series: [
        {
          label: "Time",
          value: (_self: uPlot, value: number | null) =>
            value == null || !Number.isFinite(value) ? "—" : formatClock(value, true),
        },
        ...channels.map((channel) => ({
          label: channel.label,
          scale: "y",
          stroke: seriesColor(channel.index),
          width: 2,
          spanGaps: true,
          points: {
            // uPlot decides when the samples are far enough apart to be worth
            // marking; the ring in the surface colour keeps them legible.
            size: 8,
            width: 2,
            stroke: surfaceColor(),
            fill: seriesColor(channel.index),
          },
          value: (_self: uPlot, value: number | null) =>
            value == null ? "—" : `${formatChannel(channel.key, value)} ${channel.unit}`,
        })),
        ...(showMean
          ? [
              {
                label: "Mean",
                scale: "y",
                stroke: axisColor(),
                width: 1.5,
                dash: [6, 4],
                points: { show: false },
                value: (_self: uPlot, value: number | null) =>
                  value == null || key == null
                    ? "—"
                    : `${formatChannel(key, value)} ${unit}`,
              },
            ]
          : []),
      ],
      plugins: [zoomPlugin({ onRange, onReset })],
    }),
    // theme: the canvas colours are read when the options are built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, unit, key, zeroFloor, showMean, onRange, onReset, theme],
  )

  // The window is owned outside the chart, so it is pushed in rather than
  // being whatever the data happens to span.
  useEffect(() => {
    plotRef.current?.setScale("x", { min: window.from, max: window.to })
  }, [window])

  return (
    <div
      // Refetching keeps the frame: the previous render stays up, dimmed,
      // rather than collapsing to a skeleton and jumping the layout.
      style={{ opacity: loading ? 0.65 : 1, transition: "opacity 120ms linear" }}
    >
      <UplotChart
        data={data}
        options={options}
        rebuildKey={rebuildKey}
        height={height}
        onCreate={(plot) => {
          plotRef.current = plot
          onPlot?.(plot)
          const { from, to } = windowRef.current
          plot.setScale("x", { min: from, max: to })
        }}
      />
    </div>
  )
}
