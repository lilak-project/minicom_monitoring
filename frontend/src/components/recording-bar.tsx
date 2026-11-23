import { useState } from "react"
import { Button, Tooltip } from "@mantine/core"
import { Command, Hold, Panel, Readout, StateDot, Tag } from "@neon"
import { Circle, Square, StepForward } from "lucide-react"

import { useAction } from "@/hooks/use-action"
import { api } from "@/lib/api"
import { formatChannel, formatCount } from "@/lib/format"
import { formatDuration, formatStamp } from "@/lib/time"
import type { SourceSnapshot } from "@/lib/types"

/**
 * Whether this console is being written to a file, and which run it is.
 *
 * Recording is separate from reading. The chart and the console scrollback run
 * whenever the console is open; this bar is only about the file.
 *
 * A run is one for every console: Record, New run and Stop here do the same as
 * on the All tab, for every open console at once, so all of them land in files
 * with the same run number. A console opened during a run joins it. The number
 * box is for making this service's numbering agree with the DAQ's.
 */
export function RecordingBar({
  source,
  control,
  onChanged,
}: {
  source: SourceSnapshot
  /** Monitoring shows the recording and nothing that starts or stops it. */
  control: boolean
  onChanged: () => void
}) {
  const [label, setLabel] = useState("")
  const { pending, run: act } = useAction()

  const rec = source.recording
  const open = source.status === "reading"

  const start = (next: string) =>
    void act(
      `rec:${source.id}`,
      async () => {
        const started = await api.startRun(next.trim())
        setLabel("")
        onChanged()
        return started
      },
      `Recording run ${next.trim() || source.next_run}`,
    )

  const stop = () =>
    void act(
      `rec:${source.id}`,
      async () => {
        await api.stopRun()
        onChanged()
      },
      rec ? `Stopped run ${rec.run}` : "Stopped recording",
    )

  const busy = pending === `rec:${source.id}`
  /** The NEXT run's label being edited; null while it is shown as a tag. */
  const [editing, setEditing] = useState<string | null>(null)
  const nextRun = label.trim() || source.next_run
  // Set: the typed label is the one the next run takes; Record or New run
  // with the box still open counts as pressing Set first.
  const settle = () => {
    const chosen = editing === null ? label : editing.trim() === source.next_run ? "" : editing
    setLabel(chosen)
    setEditing(null)
    return chosen
  }

  return (
    <Panel
      title={
        // What the file is (fixed: its run) on the title line; what it is
        // doing (rows, time, mean) in held numbers below (NEON rules 4, 5).
        <span className="mc-tags">
          Recording
          {rec ? (
            <Tag label="RUN" on>{rec.run}</Tag>
          ) : control && open && editing !== null ? (
            <span className="mc-nextedit">
              <input
                className="neon-input num"
                autoFocus
                value={editing}
                onChange={(event) => setEditing(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") settle()
                  if (event.key === "Escape") setEditing(null)
                }}
              />
              <Command small onRun={() => void settle()}>
                Set
              </Command>
            </span>
          ) : control && open ? (
            <button type="button" className="mc-tagkey" title="Change the next run's label" onClick={() => setEditing(nextRun)}>
              <Tag label="NEXT">{nextRun}</Tag>
            </button>
          ) : (
            <Tag label="NEXT">{nextRun}</Tag>
          )}
        </span>
      }
      actions={
        <span className="mc-keys">
          <StateDot tone={rec ? "ok" : "idle"} reserve={["recording", "not recording"]}>
            {rec ? "recording" : "not recording"}
          </StateDot>
          {control ? (
            rec ? (
              <>
                <Tooltip label={`Close run ${rec.run} and open run ${editing ?? nextRun}, on every open console`}>
                  <Button variant="default" leftSection={<StepForward size={15} />} loading={busy} onClick={() => start(settle())}>
                    New run
                  </Button>
                </Tooltip>
                <Button variant="default" leftSection={<Square size={13} fill="currentColor" />} loading={busy} onClick={stop}>
                  Stop
                </Button>
              </>
            ) : (
              <Tooltip label={open ? `Record run ${editing ?? nextRun} on every open console` : "Open the console first — there is nothing to record"}>
                <div>
                  <Button
                    variant="default"
                    leftSection={<Circle size={12} fill="currentColor" strokeWidth={0} />}
                    disabled={!open}
                    loading={busy}
                    onClick={() => start(settle())}
                  >
                    Record
                  </Button>
                </div>
              </Tooltip>
            )
          ) : null}
        </span>
      }
    >
      <div className="mc-row">
        <Readout label="Rate lines" size="text" value={<Hold reserve={["8 888 888"]}>{rec ? formatCount(rec.rows) : "—"}</Hold>} />
        <Readout label="For" size="text" value={<Hold reserve={["88.8 h"]}>{rec ? formatDuration(rec.seconds ?? 0) : "—"}</Hold>} />
        <Readout
          label="Mean"
          size="text"
          value={<Hold reserve={["8.888e+88"]}>{rec?.mean != null ? formatChannel("intr_per_s", rec.mean) : "—"}</Hold>}
          unit="intr/s"
        />
      </div>
      {/* One line either way (rule 5): which file, or that there is none. */}
      <div className="faint mc-recline" title={rec?.filename}>
        {rec
          ? `${rec.filename} · started ${formatStamp(rec.started_at)}${rec.rows === 0 ? " · the file is created on the first rate line" : ""}${rec.appended ? " · adding to a file this run already had" : ""}${rec.note ? ` · ${rec.note}` : ""}`
          : "The chart and the console below are live either way — nothing is being written to a file."}
      </div>
    </Panel>
  )
}
