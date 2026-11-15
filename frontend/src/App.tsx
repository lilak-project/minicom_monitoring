import { useEffect, useState } from "react"
import { Brand, Choice, Screen, Spacer, StateDot, Tabs, ThemeSwitch, type TabItem, type Tone } from "@neon"

import { RunsPanel } from "@/components/runs-panel"
import { ReferencePanel } from "@/components/reference-panel"
import { SourcePanel } from "@/components/source-panel"
import { SourcesPanel } from "@/components/sources-panel"
import { useAction } from "@/hooks/use-action"
import { useStatusStream } from "@/hooks/use-status-stream"
import { api } from "@/lib/api"
import { now as serverNow } from "@/lib/clock"
import { formatChannel } from "@/lib/format"
import { formatDuration } from "@/lib/time"
import type { Me, Reference, SourceSnapshot } from "@/lib/types"

/** The three tabs that are always there, whatever is open. */
const SOURCES_TAB = "sources"
const RUNS_TAB = "runs"
const REFERENCE_TAB = "reference"

/** Remembered per browser: a controller who chose to just watch stays watching. */
const MODE_KEY = "minicom.mode"
type Mode = "control" | "monitor"
/** A portal role change reaches the page within this. */
const ME_INTERVAL = 30000

/**
 * One service, two modes. Control adds, opens, closes and records consoles;
 * monitoring only watches. Who may control is the server's call (/api/me,
 * enforced on every write); anyone who may can step down to Monitor.
 */
export default function App() {
  const { sources, live, offset, refresh } = useStatusStream()
  const [me, setMe] = useState<Me | null>(null)
  const [chosen, setChosen] = useState<Mode>(() => {
    try {
      return window.localStorage.getItem(MODE_KEY) === "monitor" ? "monitor" : "control"
    } catch {
      return "control"
    }
  })
  const mayControl = me?.control ?? false
  const control = mayControl && chosen === "control"
  useEffect(() => {
    const ask = () => api.me().then(setMe).catch(() => undefined)
    ask()
    const timer = setInterval(ask, ME_INTERVAL)
    return () => clearInterval(timer)
  }, [])
  const chooseMode = (next: Mode) => {
    setChosen(next)
    try {
      window.localStorage.setItem(MODE_KEY, next)
    } catch {
      /* it just will not be remembered */
    }
  }
  const [reference, setReference] = useState<Reference | null>(null)
  const [requestedTab, setRequestedTab] = useState<string | null>(null)
  const { pending, run } = useAction()

  useEffect(() => {
    void api
      .reference()
      .then(setReference)
      .catch(() => undefined)
  }, [])

  const ids = sources.map((source) => source.id)
  // With nothing chosen, land on a console that is actually printing. Opening
  // this page on a shift is a question about the run in progress, and a closed
  // console that happens to sort first is not an answer to it.
  const first = sources.find((source) => source.status === "reading") ?? sources[0]
  const active =
    requestedTab &&
    ((control && requestedTab === SOURCES_TAB) ||
      requestedTab === RUNS_TAB ||
      requestedTab === REFERENCE_TAB ||
      ids.includes(requestedTab))
      ? requestedTab
      : (first?.id ?? (control ? SOURCES_TAB : RUNS_TAB))

  const open = (source: SourceSnapshot) =>
    void run(`open:${source.id}`, async () => {
      await api.connect(source.id)
      refresh()
    }, `Opened ${source.name}`)

  const close = (source: SourceSnapshot) =>
    void run(`close:${source.id}`, async () => {
      await api.disconnect(source.id)
      refresh()
    }, `Closed ${source.name}`)

  const recording = sources.filter((source) => source.recording).length
  const clockOff = Math.abs(offset) > 60

  const tabs: TabItem[] = [
    ...(control ? [{ value: SOURCES_TAB, label: "Sources" }] : []),
    ...sources.map((source) => ({
      value: source.id,
      label: source.name,
      // The rate itself under the name: from across the room the tab row is the panel.
      state: sourceSummary(source),
      tone: sourceTone(source),
    })),
    { value: RUNS_TAB, label: "Runs", ...(recording > 0 ? { state: `recording ${recording}`, tone: "ok" as Tone } : {}) },
    { value: REFERENCE_TAB, label: "Reference" },
  ]

  return (
    <Screen
      top={
        <>
          {/* Monitoring is stated, not implied by missing buttons. */}
          <Brand name="minicom" readOnly={!control} />
          <Tabs items={tabs} value={active} onChange={setRequestedTab} />
          <Spacer />
          {/* The socket, and this machine's clock: a clock minutes out of step
              is worth saying (times here are the server's, so the chart is
              right regardless). One dot, every wording reserved (rule 5). */}
          <span title={clockOff ? `This machine's clock is ${offset > 0 ? "behind" : "ahead of"} the server's by ${formatDuration(Math.abs(offset))}.` : undefined}>
            <StateDot
              tone={!live || clockOff ? "warn" : "ok"}
              reserve={["live", "reconnecting", "clock off 88 min"]}
            >
              {!live ? "reconnecting" : clockOff ? `clock off ${formatDuration(Math.abs(offset))}` : "live"}
            </StateDot>
          </span>
          {mayControl ? (
            <Choice
              small
              options={[
                { value: "control", label: "Control" },
                { value: "monitor", label: "Monitor" },
              ]}
              value={control ? "control" : "monitor"}
              onChange={chooseMode}
            />
          ) : null}
          <ThemeSwitch />
        </>
      }
    >
      {active === REFERENCE_TAB ? (
        <ReferencePanel reference={reference} />
      ) : active === RUNS_TAB ? (
        <RunsPanel />
      ) : active === SOURCES_TAB ? (
        <SourcesPanel sources={sources} reference={reference} onChanged={refresh} />
      ) : (
        sources
          .filter((source) => source.id === active)
          .map((source) => (
            <SourcePanel
              key={source.id}
              source={source}
              control={control}
              channels={reference?.channels ?? []}
              onConnect={() => open(source)}
              onDisconnect={() => close(source)}
              onChanged={refresh}
              busy={pending === `open:${source.id}` || pending === `close:${source.id}`}
            />
          ))
      )}
    </Screen>
  )
}

/** Lit while printing; dim when not open; pink on an error or a board gone quiet. */
function sourceTone(source: SourceSnapshot): Tone {
  if (source.status === "error") return "alarm"
  if (source.status !== "reading") return "idle"
  // Open, but the board has gone quiet: a console that has said nothing for a
  // minute is not the same as one printing, and lit for both would hide
  // exactly the case somebody needs to notice.
  if (source.last_sample_at != null && serverNow() - source.last_sample_at > 60) return "warn"
  return "ok"
}

/** The current rate, short enough to sit under the name on a tab. */
function sourceSummary(source: SourceSnapshot): string {
  if (source.status === "error") return "error"
  if (source.status !== "reading") return "not open"
  const rate = source.channels.find((channel) => channel.key === "intr_per_s")
  const run = source.recording ? ` · rec ${source.recording.run}` : ""
  if (rate?.value == null) return `no rate line yet${run}`
  return `${formatChannel("intr_per_s", rate.value)} intr/s${run}`
}
