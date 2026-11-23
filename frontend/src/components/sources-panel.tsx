import { useCallback, useEffect, useRef, useState } from "react"
import {
  ActionIcon,
  Button,
  Group,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core"
import { Pencil, Plug, Plus, Power, RefreshCw, Trash2 } from "lucide-react"

import { Fact, FactGrid, Section } from "@/components/section"
import { useAction } from "@/hooks/use-action"
import { api } from "@/lib/api"
import { describeHolder, formatCount } from "@/lib/format"
import type { Reference, SerialPort, SourceKind, SourceSnapshot } from "@/lib/types"
import { Choice } from "@neon"

/** A console being edited, before it is saved. */
interface Draft {
  id: string
  name: string
  kind: SourceKind
  port: string
  baud: number
  path: string
  autostart: boolean
  live: boolean
}

function blank(reference: Reference | null): Draft {
  return {
    id: "",
    name: "",
    kind: "serial",
    port: "",
    baud: 115200,
    path: reference?.default_capture_path ?? "",
    autostart: true,
    live: true,
  }
}

/**
 * Where the lines come from: which consoles this service knows, and the ports
 * they could be on.
 *
 * The ports list carries who already has each one open, beside the port rather
 * than as a refusal after the fact. On this bench that is usually minicom, and
 * knowing it before you press Open is the difference between choosing the
 * capture source and being told you cannot have the port.
 */
export function SourcesPanel({
  sources,
  reference,
  onChanged,
}: {
  sources: SourceSnapshot[]
  reference: Reference | null
  onChanged: () => void
}) {
  const [ports, setPorts] = useState<SerialPort[]>([])
  const [draft, setDraft] = useState<Draft>(() => blank(reference))
  const [editing, setEditing] = useState(false)
  const { pending, run } = useAction()

  const refreshPorts = useCallback(() => {
    void api
      .listPorts()
      .then(setPorts)
      .catch(() => undefined)
  }, [])

  useEffect(refreshPorts, [refreshPorts])
  // Ports come and go with the USB cables; re-scan while the tab is open.
  useEffect(() => {
    const timer = setInterval(refreshPorts, 10_000)
    return () => clearInterval(timer)
  }, [refreshPorts])

  useEffect(() => {
    if (!editing) setDraft((current) => (current.path ? current : blank(reference)))
  }, [reference, editing])

  const save = () =>
    void run(
      "save",
      async () => {
        await api.saveSource({
          id: draft.id,
          name: draft.name.trim(),
          kind: draft.kind,
          port: draft.port,
          baud: draft.baud,
          path: draft.path.trim(),
          autostart: draft.autostart,
          live: draft.live,
        })
        onChanged()
        setDraft(blank(reference))
        setEditing(false)
      },
      editing ? `Saved ${draft.name || "console"}` : `Added ${draft.name || "console"}`,
    )

  // The form is below the list: an Edit far up a long list must bring it into view,
  // or the press looks like it did nothing.
  const formRef = useRef<HTMLDivElement | null>(null)
  const edit = (source: SourceSnapshot) => {
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
    setDraft({
      id: source.id,
      name: source.name,
      kind: source.kind,
      port: source.port,
      baud: source.baud,
      path: source.path,
      autostart: source.autostart,
      live: source.live,
    })
    setEditing(true)
  }

  const kindSpec = reference?.kinds.find((kind) => kind.id === draft.kind)
  const complete =
    (draft.kind === "serial" ? draft.port !== "" : draft.path.trim() !== "")

  return (
    <Stack gap="xl">
      <Section
        title="Consoles"
        description="Each one is a serial port, or a file minicom is writing. Opening one starts a CSV."
      >
        {sources.length === 0 ? (
          <Text c="dimmed" size="sm">
            None yet. Add one below — if minicom is on the port you want, use the capture file.
          </Text>
        ) : (
          // One row per console, so a bench of eight fits one screen. A problem takes
          // a second line under its row; nothing does when all is well.
          <div className="mc-srclist">
            {sources.map((source) => {
              const save = (change: { autostart?: boolean; live?: boolean }, key: string) =>
                void run(key, async () => {
                  await api.saveSource({
                    id: source.id,
                          name: source.name,
                          kind: source.kind,
                          port: source.port,
                          baud: source.baud,
                          path: source.path,
                          autostart: source.autostart,
                          live: source.live,
                    ...change,
                  })
                  onChanged()
                })
              return (
                <div key={source.id} className="mc-srcrow">
                  <span className="mc-srcname">
                    <span className={`mc-dot tone-${source.status === "error" ? "alarm" : source.status === "reading" ? "ok" : "idle"}`} />
                    {source.name}
                  </span>
                  <span className="mc-srcorigin tabular" title={source.origin}>
                    {source.kind === "serial" ? `${source.origin} · ${source.baud}` : source.origin}
                  </span>
                  <span className="mc-srcmeta tabular">
                    {formatCount(source.samples)} lines{source.recording ? ` · run ${source.recording.run}` : ""}
                  </span>
                  <Switch size="xs" checked={source.autostart} label="Open on start"
                    onChange={(event) => save({ autostart: event.currentTarget.checked }, `autostart:${source.id}`)} />
                  <Switch size="xs" checked={source.live} label="Live mode"
                    onChange={(event) => save({ live: event.currentTarget.checked }, `live:${source.id}`)} />
                  {source.status === "reading" ? (
                    <Button size="compact-sm" variant="default" leftSection={<Power size={13} />}
                      loading={pending === `close:${source.id}`}
                      onClick={() => void run(`close:${source.id}`, async () => {
                        await api.disconnect(source.id)
                        onChanged()
                      }, `Closed ${source.name}`)}>
                      Close
                    </Button>
                  ) : (
                    <Button size="compact-sm" leftSection={<Plug size={13} />}
                      loading={pending === `open:${source.id}`}
                      onClick={() => void run(`open:${source.id}`, async () => {
                        await api.connect(source.id)
                        onChanged()
                      }, `Opened ${source.name}`)}>
                      Open
                    </Button>
                  )}
                  <Tooltip label="Edit">
                    <ActionIcon size="md" variant="default" onClick={() => edit(source)}>
                      <Pencil size={14} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Forget this console. The CSVs it wrote stay.">
                    <ActionIcon size="md" variant="default" color="red" loading={pending === `del:${source.id}`}
                      onClick={() => void run(`del:${source.id}`, async () => {
                        await api.removeSource(source.id)
                        onChanged()
                      }, `Removed ${source.name}`)}>
                      <Trash2 size={14} />
                    </ActionIcon>
                  </Tooltip>
                  {source.last_error ? <span className="mc-srcerr">{source.last_error}</span> : null}
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <div ref={formRef} className={editing ? "mc-editing" : undefined}>
      <Section
        title={editing ? `Edit ${draft.name || "console"}` : "Add a console"}
        description={kindSpec?.detail}
        action={
          editing ? (
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                setDraft(blank(reference))
                setEditing(false)
              }}
            >
              Cancel
            </Button>
          ) : null
        }
      >
        <Paper withBorder p="md" radius="md">
          <Stack gap="md">
            <div>
              <Choice
                value={draft.kind}
                onChange={(value) => setDraft({ ...draft, kind: value as SourceKind })}
                options={(reference?.kinds ?? []).map((kind) => ({ value: kind.id, label: kind.label }))}
              />
            </div>

            <Group grow align="flex-start">
              <TextInput
                label="Name"
                placeholder="the file's name if empty"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              />
              {draft.kind === "serial" ? (
                <Select
                  label="Port"
                  placeholder="/dev/ttyUSB1"
                  data={ports.map((port) => ({
                    value: port.device,
                    label:
                      port.held_by.length > 0
                        ? `${port.device} — held by ${port.held_by[0].name}`
                        : `${port.device} — ${port.description}`,
                  }))}
                  value={draft.port || null}
                  onChange={(value) => setDraft({ ...draft, port: value ?? "" })}
                  searchable
                  comboboxProps={{ withinPortal: true }}
                />
              ) : (
                <TextInput
                  label="Capture file"
                  placeholder={reference?.default_capture_path}
                  value={draft.path}
                  onChange={(event) => setDraft({ ...draft, path: event.currentTarget.value })}
                />
              )}
            </Group>

            {draft.kind === "serial" ? (
              <Group align="flex-end" gap="md">
                <Select
                  label="Baud"
                  w={160}
                  data={(reference?.baud_rates ?? [115200]).map(String)}
                  value={String(draft.baud)}
                  onChange={(value) => setDraft({ ...draft, baud: Number(value ?? 115200) })}
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: true }}
                />
                <Text size="xs" c="dimmed" pb={10}>
                  8N1, no flow control — the same settings minicom uses on this bench.
                </Text>
              </Group>
            ) : (
              <Text size="xs" c="dimmed">
                Start minicom as{" "}
                <code>minicom -D /dev/ttyUSB1 -C {draft.path || "capture.log"}</code> and it writes
                everything it shows to that file. This service follows it from the end, and keeps
                following if minicom is restarted onto a new one.
              </Text>
            )}

            <Group justify="space-between">
              <Switch
                checked={draft.autostart}
                onChange={(event) => setDraft({ ...draft, autostart: event.currentTarget.checked })}
                label="Open it whenever this service starts"
              />
              <Button
                leftSection={<Plus size={16} />}
                disabled={!complete}
                loading={pending === "save"}
                onClick={save}
              >
                {editing ? "Save" : "Add"}
              </Button>
            </Group>
          </Stack>
        </Paper>
      </Section>
      </div>

      <Section
        title="Serial ports on this machine"
        description="Who has each one open. Two readers on one tty split the byte stream and both lose lines. A minicom started with sudo is invisible to a scan of open files, so its lock file is checked too."
        action={
          <Button size="sm" variant="default" leftSection={<RefreshCw size={15} />} onClick={refreshPorts}>
            Rescan
          </Button>
        }
      >
        {ports.length === 0 ? (
          <Text c="dimmed" size="sm">
            No serial ports found.
          </Text>
        ) : (
          ports.map((port) => (
            <Paper key={port.device} withBorder p="md" radius="md">
              <FactGrid>
                <Fact label="Port" mono>
                  {port.device}
                </Fact>
                <Fact label="Device">{port.description}</Fact>
                <Fact label="USB id" mono>
                  {port.hwid || "—"}
                </Fact>
                <Fact label="Open by">
                  {port.held_by.length === 0 ? (
                    <Text span c="teal" size="sm">
                      nothing — free
                    </Text>
                  ) : (
                    port.held_by.map(describeHolder).join(", ")
                  )}
                </Fact>
              </FactGrid>
            </Paper>
          ))
        )}
      </Section>
    </Stack>
  )
}
