import { useEffect, useRef, useState } from "react"
import { Badge, Button, Group, Paper, Stack, Switch, Text } from "@mantine/core"
import { NoticeLine } from "@neon"
import { Terminal } from "lucide-react"

import { useConsole } from "@/hooks/use-console"
import { formatClock } from "@/lib/time"
import { paint } from "@/lib/paint"

/** The rate line, the one line here that becomes a number on the chart. */
const RATE_MARK = ">>>"

/**
 * What minicom's screen would be showing.
 *
 * The chart is four numbers off one line; everything else the board says --
 * the boot messages, the shell, the error that explains why the rate went to
 * zero -- only exists here. A monitoring page that showed the plot and not the
 * console would be one that cannot answer "why did it stop", which is the
 * question people open it with.
 *
 * It follows the tail until you scroll up, and then holds still. Reading a
 * traceback that jumps out from under you is worse than no console at all.
 */
export function ConsolePanel({ sourceId, name }: { sourceId: string; name: string }) {
  const [follow, setFollow] = useState(true)
  const { lines, error, gap, clear } = useConsole(sourceId, true)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(follow)
  followRef.current = follow

  useEffect(() => {
    const box = boxRef.current
    if (box && followRef.current) box.scrollTop = box.scrollHeight
  }, [lines])

  // Scrolling away from the bottom is how you ask it to stop moving; coming
  // back is how you ask it to resume. No button needed for either.
  const onScroll = () => {
    const box = boxRef.current
    if (!box) return
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24
    if (atBottom !== followRef.current) setFollow(atBottom)
  }

  return (
    <Paper withBorder p="sm">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="xs">
            <Terminal size={18} />
            <Text fw={600} size="lg">
              Console
            </Text>
            <Text size="sm" c="dimmed">
              {name}
            </Text>
          </Group>
          <Group gap="sm">
            <Switch
              size="sm"
              checked={follow}
              onChange={(event) => {
                const on = event.currentTarget.checked
                setFollow(on)
                if (on && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
              }}
              label="Follow"
            />
            <Button size="xs" variant="default" onClick={clear}>
              Clear
            </Button>
          </Group>
        </Group>

        {/* Always there (NEON rule 5): a failed read, or lines lost between
            fetches, fill this line instead of pushing the scrollback down. */}
        <NoticeLine
          tone={error ? "alarm" : gap ? "warn" : null}
          more={
            !error && gap
              ? "The board printed faster than this page could fetch, so some lines are missing here. None are missing from the CSV — that is written where the lines arrive."
              : undefined
          }
        >
          {error ? `Could not read the console: ${error}` : gap ? "Some lines are missing here (not from the CSV)" : "Every line is here"}
        </NoticeLine>

        <div ref={boxRef} onScroll={onScroll} className="console-box">
          {lines.length === 0 ? (
            <Text size="sm" c="dimmed" p="md">
              Nothing yet. The console is quiet, or it is not open — the tab colour above says
              which.
            </Text>
          ) : (
            lines.map((line) => (
              <div
                key={line.seq}
                className={line.text.includes(RATE_MARK) ? "console-line is-rate" : "console-line"}
              >
                <span className="console-time">{formatClock(line.at)}</span>
                <span>{paint(line.text)}</span>
              </div>
            ))
          )}
        </div>

        <Group gap="xs">
          <Badge size="sm" variant="default">
            {lines.length} line{lines.length === 1 ? "" : "s"} held
          </Badge>
          <Text size="xs" c="dimmed">
            Rate lines are highlighted — those are the ones that become points on the chart.
            Escape sequences are stripped, so this is the text, not the terminal.
          </Text>
        </Group>
      </Stack>
    </Paper>
  )
}
