import { useState } from "react"
import { Choice, Command, Empty, Hold, Spacer, TileGrid, Tile, type Tone } from "@neon"

import { TextCard } from "@/components/overview-text"

import { now as serverNow } from "@/lib/clock"
import { formatChannel } from "@/lib/format"
import { formatAgo } from "@/lib/time"
import { useAction } from "@/hooks/use-action"
import { api } from "@/lib/api"
import type { ChannelKey, SourceSnapshot } from "@/lib/types"

/** The board's routine messages, lit so they read at a glance among the others. */
const ROUTINE = /^(waiting for interrupt|sending heart ?beat)$/i

function Said({ text }: { text: string }) {
  const parts = text.split(" · ")
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i ? " · " : ""}
          <span className={ROUTINE.test(part.trim()) ? "mc-routine" : undefined}>{part}</span>
        </span>
      ))}
    </>
  )
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
  const columns = Math.min(Math.round(4 / scale), sources.length)
  return (
    <>
      <div className="overview-bar">
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
