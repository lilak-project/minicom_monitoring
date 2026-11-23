import { useMemo, useRef } from "react"
import {
  Badge,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core"
import { Download, ImageDown } from "lucide-react"
import type uPlot from "uplot"

import { Choice, Hold, Readout } from "@neon"
import { downloadChartPng, downloadWindowCsv, stampedName } from "@/lib/download"
import { formatChannel, formatCount } from "@/lib/format"
import { seriesColor } from "@/lib/palette"
import { formatDuration } from "@/lib/time"
import type { ChannelKey, ChannelSpec, SeriesChannel } from "@/lib/types"

import { ChartBoundary } from "./chart-boundary"
import { pointCounts } from "./chart-data"
import { RangeControls } from "./range-controls"
import { RateChart } from "./rate-chart"
import { TimeBounds } from "./time-bounds"
import type { TimeRangeControl } from "./use-time-range"

/** The widest each channel's reading gets, as formatChannel writes it (rule 5). */
const widest = (key: ChannelKey) => (key === "total_intr" ? "888,888,888" : key === "mem_pct" ? "88.88" : "88,888")

/**
 * The chart, the numbers that summarise it, and a footer saying what is drawn.
 *
 * The row of readouts is the answer to the question the page exists for --
 * "what rate is it running at, and what has it averaged?" -- so it sits above
 * the chart rather than under it. The mean, the spread and the extremes are
 * all over **the window on screen**, which is why they move when the window
 * does; the running average since the console was opened is a separate number
 * on the panel above, because it answers a different question.
 *
 * The footer states the reduction. A monitoring chart is a summary of far more
 * samples than it has pixels, and one drawn from every fourth sample is a
 * different claim from one drawn from all of them.
 */
export function ChartCard({
  channel,
  channels,
  channelKey,
  onChannelKey,
  current,
  range,
  loading,
  error,
  dataStart,
  dataEnd,
  exportName,
}: {
  /** The windowed samples, or null before the first answer arrives. */
  channel: SeriesChannel | null
  /** Everything that can be charted, for the picker. */
  channels: ChannelSpec[]
  channelKey: ChannelKey
  onChannelKey: (key: ChannelKey) => void
  /** The live value from the status socket, which is ahead of the window. */
  current: number | null
  range: TimeRangeControl
  loading: boolean
  error: string | null
  dataStart: number | null
  dataEnd: number | null
  exportName: string
}) {
  const plotRef = useRef<uPlot | null>(null)
  const list = useMemo(() => (channel ? [channel] : []), [channel])
  const counts = useMemo(() => pointCounts(list), [list])
  const stats = channel?.stats
  const empty = counts.total === 0
  const spec = channels.find((item) => item.key === channelKey)
  const unit = channel?.unit ?? spec?.unit ?? ""
  // A trigger count is monotonic and starts in the millions; forcing its axis
  // to zero would flatten the whole run into the top row of pixels.
  const zeroFloor = channelKey !== "total_intr"

  return (
    <Paper withBorder p="sm" radius="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <Choice
            value={channelKey}
            onChange={onChannelKey}
            options={channels.map((item) => ({ value: item.key, label: item.label }))}
          />
          <Group gap="xs">
            <Tooltip label="Save the window on screen as a CSV">
              <Badge
                component="button"
                variant="default"
                size="lg"
                style={{ cursor: "pointer" }}
                leftSection={<Download size={13} />}
                disabled={empty}
                onClick={() => downloadWindowCsv(list, stampedName(exportName, "csv"))}
              >
                CSV
              </Badge>
            </Tooltip>
            <Tooltip label="Save the chart as a picture">
              <Badge
                component="button"
                variant="default"
                size="lg"
                style={{ cursor: "pointer" }}
                leftSection={<ImageDown size={13} />}
                onClick={() => {
                  const canvas = plotRef.current?.ctx.canvas
                  if (canvas) downloadChartPng(canvas, stampedName(exportName, "png"))
                }}
              >
                PNG
              </Badge>
            </Tooltip>
          </Group>
        </Group>

        {/* Current first, then the average -- the two numbers somebody came
            to this page for, in the order they ask for them. */}
        {/* Each number holds the room of its widest (NEON rule 5). The mean is
            in the trace's dim colour, as the dashed line it is drawn as. */}
        <Group gap="xl" wrap="wrap">
          <Readout
            label={<><span className="mc-swatch" style={{ background: seriesColor(spec?.index ?? 0) }} />Now</>}
            size="hero"
            value={<Hold reserve={[widest(channelKey)]}>{formatChannel(channelKey, current)}</Hold>}
            unit={unit}
          />
          <Readout
            label={<><span className="mc-swatch dim" />Mean over the window</>}
            size="hero"
            value={<Hold reserve={[widest(channelKey)]}>{formatChannel(channelKey, stats?.mean)}</Hold>}
            unit={unit}
          />
          <Readout
            label="Spread (1σ)"
            value={<Hold reserve={[`±${widest(channelKey)}`]}>{stats?.stdev == null ? "—" : `±${formatChannel(channelKey, stats.stdev)}`}</Hold>}
            unit={unit}
          />
          <Readout label="Lowest" value={<Hold reserve={[widest(channelKey)]}>{formatChannel(channelKey, stats?.min)}</Hold>} unit={unit} />
          <Readout label="Highest" value={<Hold reserve={[widest(channelKey)]}>{formatChannel(channelKey, stats?.max)}</Hold>} unit={unit} />
          <Readout label="Samples in window" value={<Hold reserve={["88 888"]}>{formatCount(stats?.count ?? 0)}</Hold>} />
        </Group>

        {/* One row of controls, above the chart they scope. */}
        <RangeControls range={range} />

        {/* One slot, one height (rule 5): the chart, or why there is none, in
            the same place -- a failed read laid over it, not pushed in above. */}
        <div className="mc-chartslot">
          {empty && !loading ? (
            <div className="mc-chartempty">
              <Text c="dimmed" size="sm">
                No rate lines in this window.
              </Text>
              <Text c="dimmed" size="xs">
                {/* Said plainly, because the two reasons need different actions:
                    a window from before the console was opened, or a board that
                    is not printing -- which is not the same as a board that is
                    idle, and the console below tells them apart. */}
                Widen it or press All — or, if this console has only just been
                opened, wait for the board's next rate line. The raw console
                below shows whether anything is arriving at all.
              </Text>
            </div>
          ) : (
            <ChartBoundary>
              <RateChart
                channels={list}
                window={range.window}
                mean={stats?.mean ?? null}
                zeroFloor={zeroFloor}
                loading={loading}
                onRange={range.setWindow}
                onReset={range.reset}
                onPlot={(plot) => {
                  plotRef.current = plot
                }}
              />
            </ChartBoundary>
          )}
          {error ? (
            <div className="mc-chartfail tone-text-alarm" role="alert">
              ■ Could not read the samples: {error}
            </div>
          ) : null}
        </div>

        <Group gap="lg" wrap="wrap">
          {/* How to steer the chart is on hover, not a line of its own (one screen). */}
          <Text size="xs" c="dimmed" title="Drag across the chart to zoom to that interval · shift-drag to pan · double-click to go back · the wheel scrolls the page">
            {formatDuration(range.window.to - range.window.from)} shown ·{" "}
            {counts.shown === counts.total ? (
              <>every one of {formatCount(counts.total)} samples</>
            ) : (
              <>
                {formatCount(counts.shown)} points drawn from {formatCount(counts.total)} samples
              </>
            )}
            {" · the mean is over all "}
            {formatCount(stats?.count ?? 0)}, not over the points drawn
          </Text>
          {counts.shown < counts.total ? (
            <Text size="xs" c="dimmed">
              Reduced by keeping the highest and lowest of each interval, so a one-sample
              spike is still on the chart.
            </Text>
          ) : null}
          {/* Always in the row, seen only while loading: nothing shifts. */}
          <Loader size="xs" style={{ visibility: loading ? "visible" : "hidden" }} />
        </Group>


        {/* The fine adjustment, under the thing it adjusts. */}
        <TimeBounds range={range} dataStart={dataStart} dataEnd={dataEnd} />
      </Stack>
    </Paper>
  )
}
