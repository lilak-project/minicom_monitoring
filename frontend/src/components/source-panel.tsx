import { useEffect, useMemo, useRef, useState } from "react"
import { Button, Code, Text } from "@mantine/core"
import { NoticeLine, Panel, StateDot, Tag } from "@neon"
import { Plug, Power } from "lucide-react"

import { ChartCard } from "@/components/chart/chart-card"
import { useTimeRange } from "@/components/chart/use-time-range"
import { ConsolePanel } from "@/components/console-panel"
import { RecordingBar } from "@/components/recording-bar"
import { Fact, FactGrid } from "@/components/section"
import { useSeries } from "@/hooks/use-series"
import { now as serverNow } from "@/lib/clock"
import { describeHolder, formatChannel, formatCount } from "@/lib/format"
import { formatAgo, formatDuration } from "@/lib/time"
import type { ChannelKey, ChannelSpec, SourceSnapshot } from "@/lib/types"

/**
 * One console: what it is reading now, over the window you choose, and the
 * raw text underneath.
 *
 * The two halves answer different questions and both are needed. The chart
 * says what the rate has been doing; the console says why. A run that dropped
 * to zero looks the same on the plot whether the board crashed, the trigger
 * was disabled, or the cable came out -- and the line that says which is
 * always in the text.
 */
export function SourcePanel({
  source,
  control,
  channels,
  onConnect,
  onDisconnect,
  onChanged,
  busy,
}: {
  source: SourceSnapshot
  /** Monitoring draws nothing that opens, closes or records. */
  control: boolean
  channels: ChannelSpec[]
  onConnect: () => void
  onDisconnect: () => void
  /** Something a button did needs to land before the next status frame. */
  onChanged: () => void
  busy: boolean
}) {
  const [channelKey, setChannelKey] = useState<ChannelKey>("intr_per_s")

  const reading = source.status === "reading"
  const live = source.channels.find((channel) => channel.key === channelKey)
  const first = source.channels[0]

  const range = useTimeRange(first?.first_at ?? null, null)
  const { channel, loading, error, push } = useSeries(source.id, channelKey, range.window, {
    follow: range.follow,
  })

  // Everything arriving on the status socket goes straight onto the end of the
  // trace, so the chart moves at the rate the board prints rather than at the
  // rate the window is refetched.
  const pushedRef = useRef<number>(0)
  useEffect(() => {
    if (live?.at == null || live.value == null) return
    if (live.at <= pushedRef.current) return
    pushedRef.current = live.at
    push(live.at, live.value)
  }, [live?.at, live?.value, push])

  // A different console, or a different quantity, is a different trace.
  useEffect(() => {
    pushedRef.current = 0
  }, [source.id, channelKey])

  const spec = channels.find((item) => item.key === channelKey)
  const meanChannel = source.channels.find((item) => item.key === "intr_per_s")
  const exportName = useMemo(() => `${source.name}_${channelKey}`, [source.name, channelKey])

  // The three things that can be wrong with a console, worst first, on the
  // one line that is always there (NEON rule 5).
  const held = source.kind === "serial" && source.held_by.length > 0 && !reading
  const problem = source.last_error
    ? { tone: "alarm" as const, text: `The reader stopped: ${source.last_error}`, more: undefined }
    : held
      ? {
          tone: "warn" as const,
          text: `${source.port} is open by ${source.held_by.map(describeHolder).join(", ")}`,
          more: (
            <>
              Two readers on one tty split the byte stream and both lose lines, so this will not
              open until that stops. If that is minicom and you want to leave it running, restart
              it with <code>-C {source.name.replace(/[^A-Za-z0-9_-]+/g, "_")}.cap</code> and add the
              same console here as a capture file instead.
            </>
          ),
        }
      : source.unparsed > 0
        ? {
            tone: "warn" as const,
            text: `${formatCount(source.unparsed)} rate lines could not be read`,
            more: (
              <>
                The board printed something shaped like a rate line that this service does not know
                how to parse, so those lines are on the console below and in no chart or CSV. The
                last one was:
                <Code block mt="xs">
                  {source.last_unparsed}
                </Code>
              </>
            ),
          }
        : null

  return (
    <div className="mc-stack">
      <Panel
        title={
          // What the console IS -- where it is read from -- as a fixed tag (rule 4).
          <span className="mc-tags">
            {source.name}
            <Tag label="FROM">{source.kind === "serial" ? `${source.port} · ${source.baud} 8N1` : source.path}</Tag>
          </span>
        }
        actions={
          <span className="mc-keys">
            <StateDot
              tone={source.status === "error" ? "alarm" : reading ? "ok" : "idle"}
              reserve={["error", "reading", "not open"]}
            >
              {source.status === "error" ? "error" : reading ? "reading" : "not open"}
            </StateDot>
            {control ? (
              reading ? (
                <Button variant="default" leftSection={<Power size={16} />} loading={busy} onClick={onDisconnect}>
                  Close
                </Button>
              ) : (
                <Button variant="default" leftSection={<Plug size={16} />} loading={busy} onClick={onConnect}>
                  Open
                </Button>
              )
            ) : null}
          </span>
        }
      >
        <div className="mc-stack">
          <NoticeLine tone={problem?.tone ?? null} more={problem?.more}>
            {problem?.text ?? (reading ? "Reading the console" : "Not open")}
          </NoticeLine>

          <FactGrid>
            <Fact label="Average since opened">
              {meanChannel && source.session_mean != null
                ? `${formatChannel("intr_per_s", source.session_mean)} intr/s over ${formatCount(source.samples)} rate lines`
                : "no rate lines yet"}
            </Fact>
            <Fact label="Last rate line">
              {source.last_sample_at ? formatAgo(source.last_sample_at) : "never"}
            </Fact>
            <Fact label="Console lines">
              {formatCount(source.lines)} seen, {formatCount(source.samples)} of them rate lines
              {source.unparsed > 0 ? `, ${formatCount(source.unparsed)} unreadable` : ""}
            </Fact>
            <Fact label="Runs seen">
              {source.runs === 0
                ? "none"
                : `${source.runs} — the board's trigger count restarting is what marks one`}
            </Fact>
            <Fact label="Open for">
              {source.opened_at ? formatDuration(serverNow() - source.opened_at) : "—"}
            </Fact>
            <Fact label="Recording">
              {source.recording
                ? `run ${source.recording.run} — ${formatCount(source.recording.rows)} rate lines so far`
                : "no — the chart is live, but nothing is being written to a file"}
            </Fact>
            <Fact label="Board's run clock">{source.run_time || "—"}</Fact>
          </FactGrid>
        </div>
      </Panel>

      <RecordingBar source={source} control={control} onChanged={onChanged} />

      <ChartCard
        channel={channel}
        channels={channels}
        channelKey={channelKey}
        onChannelKey={setChannelKey}
        current={live?.value ?? null}
        range={range}
        loading={loading}
        error={error}
        dataStart={first?.first_at ?? null}
        dataEnd={null}
        exportName={exportName}
      />

      {spec ? (
        <Text size="sm" c="dimmed">
          {spec.label} — {spec.description}
        </Text>
      ) : null}

      <ConsolePanel sourceId={source.id} name={source.origin} />
    </div>
  )
}
