import { useState } from "react"
import { Choice, Command, Empty, Hold, Spacer, Tag, TileGrid, Tile, type Tone } from "@neon"

import { TextCard } from "@/components/overview-text"

import { now as serverNow } from "@/lib/clock"
import { formatBytes, formatChannel } from "@/lib/format"
import { formatAgo, formatDuration } from "@/lib/time"
import { useAction } from "@/hooks/use-action"
import { api } from "@/lib/api"
import type { ChannelKey, DaqSummary, SourceSnapshot } from "@/lib/types"
import { paint } from "@/lib/paint"

/** The board's last message(s), its routine ones in their colours. */
function Said({ text }: { text: string }) {
  return <>{paint(text)}</>
}

/** Tile sizes, smallest first; the default (1) puts eight on one screen. Each
 *  step scales the whole tile, words and numbers alike, and fewer fit across. */
const SIZES = [0.75, 0.875, 1, 1.25, 1.5, 2]
const DEFAULT_SIZE = 2
const SIZE_KEY = "minicom.allSize"
/** Numbers (tiles) or text (each console's own lines), remembered per browser. */
const VIEW_KEY = "minicom.allView"
type View = "numbers" | "text"
/** Text mode's columns (1–4), remembered per browser; two by default. */
const COLS_KEY = "minicom.allTextCols"

function savedCols(): number {
  try {
    const n = Number(window.localStorage.getItem(COLS_KEY))
    return n >= 1 && n <= 4 ? n : 2
  } catch {
    return 2
  }
}

function savedView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "text" ? "text" : "numbers"
  } catch {
    return "numbers"
  }
}

function savedSize(): number {
  try {
    const n = Number(window.localStorage.getItem(SIZE_KEY))
    return Number.isInteger(n) && n >= 0 && n < SIZES.length && window.localStorage.getItem(SIZE_KEY) !== null ? n : DEFAULT_SIZE
  } catch {
    return DEFAULT_SIZE
  }
}

/**
 * Every console at once, one tile each: the trigger rate large, the other three
 * numbers of the rate line under it, each in its own cell, and the last thing
 * the board said. Eight fit one screen (four across, two down); − and + make the
 * tiles smaller or larger. A tile opens its console's own tab.
 */
export function OverviewPanel({
  sources,
  tone,
  onPick,
  control,
  onChanged,
}: {
  sources: SourceSnapshot[]
  tone: (source: SourceSnapshot) => Tone
  onPick: (id: string) => void
  /** Monitoring draws no Clear. */
  control: boolean
  onChanged: () => void
}) {
  const [size, setSize] = useState(savedSize)
  const [view, setView] = useState<View>(savedView)
  const [textCols, setTextCols] = useState(savedCols)
  const chooseCols = (next: number) => {
    setTextCols(next)
    try {
      window.localStorage.setItem(COLS_KEY, String(next))
    } catch {
      /* not remembered; still applied */
    }
  }
  const chooseView = (next: View) => {
    setView(next)
    try {
      window.localStorage.setItem(VIEW_KEY, next)
    } catch {
      /* not remembered; still applied */
    }
  }
  const { pending, run } = useAction()
  const clearAll = () =>
    void run("clear", async () => {
      await Promise.all(sources.map((source) => api.clear(source.id)))
      onChanged()
    }, "Cleared the charts and numbers")
  // One run across every console: the number is shared, so it is read off any of them.
  const current = sources[0]?.current_run ?? null
  const nextRun = sources[0]?.next_run ?? ""
  const startRun = () =>
    void run("run", async () => {
      const started = await api.startRun()
      onChanged()
      return started
    }, current ? `Closed run ${current.run}, recording run ${nextRun}` : `Recording run ${nextRun}`)
  const stopRun = () =>
    void run("run", async () => {
      await api.stopRun()
      onChanged()
    }, current ? `Stopped run ${current.run}` : "Stopped")
  const toggleFollow = () =>
    void run("run", async () => {
      await api.followDaq(!follow.on)
      onChanged()
    }, follow.on ? "Runs are started by hand" : "Following the DAQ's runs")
  const pick = (next: number) => {
    setSize(next)
    try {
      window.localStorage.setItem(SIZE_KEY, String(next))
    } catch {
      /* not remembered; still applied */
    }
  }
  if (sources.length === 0) return <Empty>No consoles yet</Empty>
  const scale = SIZES[size]
  const follow = sources[0]?.follow_daq ?? { on: false, error: null, daq: null }
  const columns = Math.min(Math.round(4 / scale), sources.length + (follow.on ? 1 : 0))
  return (
    <>
      <div className="overview-bar">
        {current ? <Tag label="RUN" on>{current.run}</Tag> : <Tag label="NEXT">{nextRun}</Tag>}
        {control ? (
          <Command small on={follow.on} disabled={pending === "run"} onRun={toggleFollow}>
            Follow DAQ
          </Command>
        ) : follow.on ? (
          <span className="faint">follows DAQ</span>
        ) : null}
        {follow.on && follow.error ? (
          <span className="mc-followerr" title={follow.error}>DAQ not answering</span>
        ) : null}
        {control && !follow.on ? (
          current ? (
            <>
              <Command small primary disabled={pending === "run"} onRun={startRun}>
                New run
              </Command>
              <Command small danger confirm={`Stop run ${current.run}?`} disabled={pending === "run"} onRun={stopRun}>
                Stop
              </Command>
            </>
          ) : (
            <Command small primary disabled={pending === "run"} onRun={startRun}>
              Start run
            </Command>
          )
        ) : null}
        {control ? (
          // Two presses: it throws away every console's chart and means at once.
          <Command small confirm={`Clear all ${sources.length}?`} disabled={pending === "clear"} onRun={clearAll}>
            Clear
          </Command>
        ) : null}
        <Choice
          small
          options={[
            { value: "numbers", label: "Numbers" },
            { value: "text", label: "Text" },
          ]}
          value={view}
          onChange={chooseView}
        />
        {view === "text" ? (
          // How many strips across: the height is shared out so eight still fit one screen.
          <Choice small options={[1, 2, 3, 4].map((n) => ({ value: n, label: `${n} across` }))} value={textCols} onChange={chooseCols} />
        ) : null}
        <Spacer />
        <Command small disabled={size === 0} onRun={() => pick(size - 1)}>
          −
        </Command>
        <Hold reserve={["200 %"]}>{Math.round(scale * 100)} %</Hold>
        <Command small disabled={size === SIZES.length - 1} onRun={() => pick(size + 1)}>
          +
        </Command>
      </div>
      {/* zoom scales the tile's px with it, so minWidth grows too and fewer fit across. */}
      <div className="mc-overview" style={{ zoom: scale }}>
        {view === "text" ? (
          // Text runs sideways: wide strips, `textCols` across, the screen's height shared
          // among the rows eight consoles need (− / + still scale the text).
          <div
            className="mc-textgrid"
            style={{
              gridTemplateColumns: `repeat(${textCols}, minmax(0, 1fr))`,
              ["--mc-rows" as string]: Math.ceil(Math.min(sources.length, 8) / textCols),
            }}
          >
            {sources.map((source) => (
              <TextCard key={source.id} source={source} className={`tone-${tone(source)}`} onPick={() => onPick(source.id)} />
            ))}
          </div>
        ) : (
        <TileGrid columns={columns} minWidth={290}>
          {follow.on ? <DaqTile error={follow.error} daq={follow.daq} /> : null}
          {sources.map((source) => {
            const reading = source.status === "reading"
            const v = (key: ChannelKey) =>
              formatChannel(key, source.channels.find((channel) => channel.key === key)?.value)
            const quiet = reading && source.last_sample_at != null && serverNow() - source.last_sample_at > 60
            const said = [quiet && source.last_sample_at ? `silent ${formatAgo(source.last_sample_at)}` : null, source.last_info]
              .filter(Boolean)
              .join(" · ")
            return (
              <Tile
                key={source.id}
                label={source.name}
                // The run number is fixed for the run: a tag, not a big number (NEON rule 4).
                tag={source.recording ? `RUN ${source.recording.run}` : source.status === "error" ? "ERROR" : reading ? "" : "NOT OPEN"}
                tone={tone(source)}
                value={reading ? v("intr_per_s") : "—"}
                unit={reading ? "intr/s" : undefined}
                facts={
                  reading
                    ? [
                        { label: "data", value: v("mbps"), unit: "MB/s" },
                        { label: "memory", value: v("mem_pct"), unit: "%" },
                        { label: "total", value: v("total_intr") },
                      ]
                    : undefined
                }
                // Always one line, so a tile with nothing to say is as tall as one that has.
                sub={
                  reading ? (
                    <span title={source.last_info ?? undefined}>{said ? <Said text={said} /> : "—"}</span>
                  ) : (
                    source.last_error ?? source.origin
                  )
                }
                // The last ten minutes of the rate, behind the numbers.
                trace={reading && source.trace.length > 1 ? source.trace : undefined}
                mean={source.session_mean}
                onClick={() => onPick(source.id)}
              />
            )
          })}
        </TileGrid>
        )}
      </div>
    </>
  )
}

/** The GANIL DAQ beside the consoles, while minicom follows its runs. */
function DaqTile({ error, daq }: { error: string | null; daq: DaqSummary | null }) {
  const live = daq?.live ?? null
  const tone: Tone = error || (daq && !daq.daq_up) ? "alarm" : daq && daq.down.length ? "warn" : live ? "ok" : "idle"
  return (
    <Tile
      label="GANIL DAQ"
      tag={error ? "NO ANSWER" : !daq ? "" : live ? `RUN ${live.run}` : daq.daq_up ? "IDLE" : "DOWN"}
      tone={tone}
      value={live ? formatDuration(live.elapsed_s) : "—"}
      unit={live ? "running" : undefined}
      facts={[
        { label: "written", value: live ? (live.storage_off ? "storage off" : formatBytes(live.size)) : "—" },
        { label: "rate", value: daq?.rate_bytes_per_s != null ? `${formatBytes(daq.rate_bytes_per_s)}/s` : "—" },
        { label: "components", value: daq ? `${daq.components - daq.down.length} / ${daq.components}` : "—" },
      ]}
      sub={
        <span title={error ?? live?.note ?? undefined}>
          {error
            ? error
            : daq && !daq.daq_up
              ? "no DAQ process is running"
              : daq?.down.length
                ? `down: ${daq.down.join(", ")}`
                : live?.note || "—"}
        </span>
      }
    />
  )
}
