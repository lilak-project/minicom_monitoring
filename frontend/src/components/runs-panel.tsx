import { useCallback, useEffect, useState } from "react"
import { Anchor, Badge, Group, Paper, Stack, Table, Text } from "@mantine/core"
import { Download } from "lucide-react"

import { Section } from "@/components/section"
import { api } from "@/lib/api"
import { formatBytes, formatChannel, formatCount } from "@/lib/format"
import { formatDuration, formatStamp } from "@/lib/time"
import type { RunList } from "@/lib/types"

/** A live run's row keeps up without the whole table being refetched often. */
const POLL_MS = 5000

/**
 * Every recording that has been taken, and what was in it.
 *
 * One row per recording, not per file: recording run 34 twice appends to the
 * same CSV and is two rows, because they are two spans of time with two
 * summaries and pretending otherwise would average them together.
 *
 * The summary — how long, how many rate lines, and what the trigger rate
 * averaged — is what makes this a list of runs rather than a list of files.
 * It is accumulated as the samples arrive, so it is exact and costs nothing;
 * for a recording the service was killed in the middle of, it is recomputed
 * from the CSV, and the row says so.
 */
export function RunsPanel() {
  const [data, setData] = useState<RunList | null>(null)

  const refresh = useCallback(() => {
    void api
      .listRuns()
      .then(setData)
      .catch(() => undefined)
  }, [])

  useEffect(refresh, [refresh])
  useEffect(() => {
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const runs = data?.runs ?? []

  return (
    <Stack gap="xl">
      <Section
        title="Runs"
        description={
          data ? (
            <>
              One file per run, in <span className="tabular">{data.csv_dir}</span>, named the way{" "}
              <span className="tabular">cobo_rate_logger.py --run</span> names them. Flushed on
              every rate line, so a service killed mid-run keeps everything up to the last one.
              The next unnumbered run would be <strong>{data.next_run}</strong>.
            </>
          ) : null
        }
      >
        {data && runs.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing recorded yet. Opening a console starts a run; the bar above its chart is
            where it is stopped and started.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={900}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Run</Table.Th>
                  <Table.Th>Console</Table.Th>
                  <Table.Th>Started</Table.Th>
                  <Table.Th>Length</Table.Th>
                  <Table.Th>Rate lines</Table.Th>
                  <Table.Th>Mean</Table.Th>
                  <Table.Th>Lowest–highest</Table.Th>
                  <Table.Th>File</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {runs.map((entry) => (
                  <Table.Tr key={entry.id}>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Text fw={600} className="tabular">
                          {entry.run}
                        </Text>
                        {entry.running ? (
                          <Badge size="xs" color="red" variant="light">
                            recording
                          </Badge>
                        ) : null}
                        {entry.interrupted ? (
                          <Badge size="xs" color="yellow" variant="light">
                            interrupted
                          </Badge>
                        ) : null}
                        {entry.appended ? (
                          <Badge size="xs" variant="default">
                            appended
                          </Badge>
                        ) : null}
                      </Group>
                      {entry.note ? (
                        <Text size="xs" c="dimmed">
                          {entry.note}
                        </Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td>{entry.source_name}</Table.Td>
                    <Table.Td className="tabular">{formatStamp(entry.started_at)}</Table.Td>
                    <Table.Td className="tabular">
                      {entry.seconds == null ? "—" : formatDuration(entry.seconds)}
                    </Table.Td>
                    <Table.Td className="tabular">{formatCount(entry.rows)}</Table.Td>
                    <Table.Td className="tabular">
                      {entry.mean == null ? "—" : `${formatChannel("intr_per_s", entry.mean)} intr/s`}
                    </Table.Td>
                    <Table.Td className="tabular">
                      {entry.min == null || entry.max == null
                        ? "—"
                        : `${formatChannel("intr_per_s", entry.min)} – ${formatChannel("intr_per_s", entry.max)}`}
                    </Table.Td>
                    <Table.Td>
                      {entry.rows === 0 ? (
                        <Text size="sm" c="dimmed">
                          not written yet
                        </Text>
                      ) : (
                        <Anchor href={api.logDownloadUrl(entry.filename)} download size="sm">
                          <Group gap={4} wrap="nowrap">
                            <Download size={14} /> CSV
                          </Group>
                        </Anchor>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}

        {data ? (
          <Paper withBorder p="md" radius="md">
            <Text size="sm" c="dimmed" mb="xs">
              Columns in every file
            </Text>
            <Group gap={6}>
              {data.columns.map((column) => (
                <Badge key={column} size="sm" variant="default" className="tabular">
                  {column}
                </Badge>
              ))}
            </Group>
          </Paper>
        ) : null}

        <Text size="xs" c="dimmed">
          These hold every rate line at full rate. The CSV button on a chart saves only the
          window on screen, decimated as drawn.
        </Text>
      </Section>

      {data && data.unlisted.length > 0 ? (
        <Section
          title="Other files in the log directory"
          description="CSVs no recording accounts for — copied in by hand, or written by another program. Listed rather than hidden: a file in this folder that the page does not mention is a file somebody will assume was lost."
        >
          <Table.ScrollContainer minWidth={560}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>File</Table.Th>
                  <Table.Th>Last written</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.unlisted.map((file) => (
                  <Table.Tr key={file.filename}>
                    <Table.Td className="tabular">{file.filename}</Table.Td>
                    <Table.Td className="tabular">{formatStamp(file.modified)}</Table.Td>
                    <Table.Td className="tabular">{formatBytes(file.size)}</Table.Td>
                    <Table.Td>
                      <Anchor href={api.logDownloadUrl(file.filename)} download size="sm">
                        <Group gap={4} wrap="nowrap">
                          <Download size={14} /> CSV
                        </Group>
                      </Anchor>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Section>
      ) : null}
    </Stack>
  )
}
