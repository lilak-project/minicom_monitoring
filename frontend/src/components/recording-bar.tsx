import { useState } from "react"
import { Badge, Button, Group, Paper, Stack, Text, TextInput, Tooltip } from "@mantine/core"
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
 * whenever the console is open; this bar is only about the file. Opening a
 * console starts a recording, because on a shift the failure that costs
 * something is forgetting to press record — but it can be stopped, and the
 * chart carries on regardless, so stopping is cheap.
 *
 * **New run** is the button that gets used: it closes the current file and
 * opens the next number in one step, which is what starting a new run on the
 * DAQ means here. The number box is for making this service's numbering agree
 * with the DAQ's when they drift apart.
 */
export function RecordingBar({
  source,
  onChanged,
}: {
  source: SourceSnapshot
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
        const started = await api.startRecording(source.id, next.trim())
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
        await api.stopRecording(source.id)
        onChanged()
      },
      rec ? `Stopped run ${rec.run}` : "Stopped recording",
    )

  const busy = pending === `rec:${source.id}`

  return (
    <Paper withBorder p="md" radius="md" bg={rec ? "red.0" : undefined}>
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Group gap="xs">
            {rec ? (
              <>
                {/* The one red thing on the page, and it means one thing. */}
                <Circle size={12} fill="var(--mantine-color-red-7)" strokeWidth={0} className="rec-dot" />
                <Text fw={600}>Recording run {rec.run}</Text>
                <Badge size="sm" variant="default" className="tabular">
                  {formatCount(rec.rows)} rate line{rec.rows === 1 ? "" : "s"}
                </Badge>
                <Badge size="sm" variant="default" className="tabular">
                  {formatDuration(rec.seconds ?? 0)}
                </Badge>
                {rec.mean != null ? (
                  <Badge size="sm" variant="default" className="tabular">
                    mean {formatChannel("intr_per_s", rec.mean)} intr/s
                  </Badge>
                ) : null}
              </>
            ) : (
              <>
                <Circle size={12} strokeWidth={2} color="var(--mantine-color-gray-5)" />
                <Text fw={600} c="dimmed">
                  Not recording
                </Text>
                <Text size="sm" c="dimmed">
                  the chart and the console below are live either way — nothing is being written
                  to a file
                </Text>
              </>
            )}
          </Group>

          {rec ? (
            <Text size="xs" c="dimmed" className="tabular">
              {rec.filename} · started {formatStamp(rec.started_at)}
              {rec.rows === 0 ? " · the file is created on the first rate line" : ""}
              {rec.appended ? " · adding to a file this run already had" : ""}
              {rec.note ? ` · ${rec.note}` : ""}
            </Text>
          ) : null}
        </Stack>

        <Group gap="xs" align="flex-end">
          <TextInput
            size="sm"
            w={116}
            label="Run"
            placeholder={source.next_run}
            value={label}
            disabled={!open}
            onChange={(event) => setLabel(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && open && !busy) start(label)
            }}
          />
          {rec ? (
            <>
              <Tooltip label={`Close run ${rec.run} and open run ${label.trim() || source.next_run}`}>
                <Button
                  size="sm"
                  leftSection={<StepForward size={15} />}
                  loading={busy}
                  onClick={() => start(label)}
                >
                  New run
                </Button>
              </Tooltip>
              <Button
                size="sm"
                variant="default"
                leftSection={<Square size={13} fill="currentColor" />}
                loading={busy}
                onClick={stop}
              >
                Stop
              </Button>
            </>
          ) : (
            <Tooltip
              label={
                open
                  ? `Write to run ${label.trim() || source.next_run}`
                  : "Open the console first — there is nothing to record"
              }
            >
              <div>
                <Button
                  size="sm"
                  color="red"
                  leftSection={<Circle size={12} fill="currentColor" strokeWidth={0} />}
                  disabled={!open}
                  loading={busy}
                  onClick={() => start(label)}
                >
                  Record
                </Button>
              </div>
            </Tooltip>
          )}
        </Group>
      </Group>
    </Paper>
  )
}
