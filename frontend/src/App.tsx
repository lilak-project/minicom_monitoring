import { useEffect, useState } from "react"
import { AppShell, Badge, Container, Group, Stack, Tabs, Text, Title, Tooltip } from "@mantine/core"
import { BookOpen, Database, FolderClock } from "lucide-react"

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
import type { Reference, SourceSnapshot } from "@/lib/types"

/** The three tabs that are always there, whatever is open. */
const SOURCES_TAB = "sources"
const RUNS_TAB = "runs"
const REFERENCE_TAB = "reference"

export default function App() {
  const { sources, live, offset, refresh } = useStatusStream()
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
    (requestedTab === SOURCES_TAB ||
      requestedTab === RUNS_TAB ||
      requestedTab === REFERENCE_TAB ||
      ids.includes(requestedTab))
      ? requestedTab
      : (first?.id ?? SOURCES_TAB)

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

  const reading = sources.filter((source) => source.status === "reading").length
  const recording = sources.filter((source) => source.recording).length

  return (
    <AppShell header={{ height: { base: 104, md: 132 } }} padding={0}>
      {/* The header is fixed, so the tabs stay reachable however far you
          scroll. No bottom rule: the tabs are coloured blocks and separate
          themselves. */}
      <AppShell.Header withBorder={false}>
        <Container h={64}>
          <Group h="100%" justify="space-between" wrap="nowrap">
            <Group gap="md" wrap="nowrap" style={{ minWidth: 0 }}>
              <Title order={1} fz="h3" fw={600} className="app-title">
                minicom Monitoring
              </Title>
              <Badge size="md" radius="sm" variant="light" color={live ? "teal" : "red"}>
                {live ? "Live" : "Reconnecting"}
              </Badge>
              <Badge size="md" radius="sm" variant="default" visibleFrom="sm">
                {reading === 0
                  ? "no console open"
                  : `${reading} console${reading === 1 ? "" : "s"} open`}
              </Badge>
              {/* A clock this far out is worth saying out loud. The chart is
                  drawn against the server's clock either way, so nothing here
                  is wrong because of it -- but a machine minutes out of step
                  will be confusing in every other tool on the bench too. */}
              {Math.abs(offset) > 60 ? (
                <Tooltip
                  label={`This machine's clock is ${offset > 0 ? "behind" : "ahead of"} the server's by ${formatDuration(Math.abs(offset))}. Times on this page are the server's, so the chart is right regardless.`}
                >
                  <Badge size="md" radius="sm" variant="light" color="yellow">
                    clock off by {formatDuration(Math.abs(offset))}
                  </Badge>
                </Tooltip>
              ) : null}
            </Group>
          </Group>
        </Container>

        <Container>
          <Tabs value={active} onChange={setRequestedTab} variant="pills">
            <Tabs.List>
              <StateTab
                value={SOURCES_TAB}
                active={active === SOURCES_TAB}
                tone="blue"
                name="Sources"
                icon={<Database size={16} />}
                state={
                  sources.length > 0
                    ? `${sources.length} console${sources.length === 1 ? "" : "s"}`
                    : "nothing yet"
                }
              />

              {sources.map((source) => (
                <StateTab
                  key={source.id}
                  value={source.id}
                  active={active === source.id}
                  tone={sourceTone(source)}
                  name={source.name}
                  /* The rate itself under the name: from across the room the
                     tab row is the panel. */
                  state={sourceSummary(source)}
                />
              ))}

              <StateTab
                value={RUNS_TAB}
                active={active === RUNS_TAB}
                tone={recording > 0 ? "red" : "gray"}
                name="Runs"
                icon={<FolderClock size={16} />}
                state={recording > 0 ? `recording ${recording}` : "recorded runs"}
                style={{ marginInlineStart: "auto" }}
              />

              {/* Reference, not a console: an icon alone at the far end, so it
                  never competes with the tabs you switch between. */}
              <Tabs.Tab
                value={REFERENCE_TAB}
                className="state-tab icon-tab"
                aria-label="Reference — what the numbers are and where they come from"
                style={toneVars("gray", active === REFERENCE_TAB)}
              >
                <BookOpen size={20} />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs>
        </Container>
      </AppShell.Header>

      <AppShell.Main>
        <Container py="xl">
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
                  channels={reference?.channels ?? []}
                  onConnect={() => open(source)}
                  onDisconnect={() => close(source)}
                  onChanged={refresh}
                  busy={pending === `open:${source.id}` || pending === `close:${source.id}`}
                />
              ))
          )}
        </Container>
      </AppShell.Main>
    </AppShell>
  )
}

type Tone = "blue" | "teal" | "gray" | "red"

function sourceTone(source: SourceSnapshot): Tone {
  if (source.status === "error") return "red"
  if (source.status !== "reading") return "gray"
  // Open, but the board has gone quiet: a console that has said nothing for a
  // minute is not the same as one printing, and green for both would hide
  // exactly the case somebody needs to notice.
  if (source.last_sample_at != null && serverNow() - source.last_sample_at > 60) return "red"
  return "teal"
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

function toneVars(tone: Tone, active: boolean): React.CSSProperties {
  return {
    "--tt-bg": `var(--mantine-color-${tone}-${active ? 7 : 0})`,
    "--tt-fg": active ? "var(--mantine-color-white)" : `var(--mantine-color-${tone}-9)`,
    "--tt-bd": `var(--mantine-color-${tone}-${active ? 7 : 2})`,
    "--tt-hover": `var(--mantine-color-${tone}-${active ? 8 : 1})`,
  } as React.CSSProperties
}

/**
 * One tab: the name on top, what it is reading underneath, tinted by state.
 *
 * The colour is the point -- from across the room the tab row says which
 * consoles are alive before any of the words are readable.
 */
function StateTab({
  value,
  active,
  tone,
  name,
  state,
  icon,
  style,
}: {
  value: string
  active: boolean
  tone: Tone
  name: string
  state: string
  icon?: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <Tabs.Tab
      value={value}
      className="state-tab"
      fz="sm"
      py={6}
      leftSection={icon}
      style={{ ...toneVars(tone, active), ...style }}
    >
      <Stack gap={0} align="flex-start">
        <Text fw={500} className="tab-name">
          {name}
        </Text>
        <Text size="xs" fw={400} className="tab-meta tab-state tabular">
          {state}
        </Text>
      </Stack>
    </Tabs.Tab>
  )
}
