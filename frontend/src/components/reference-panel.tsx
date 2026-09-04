import { Code, Paper, Stack, Text } from "@mantine/core"

import { Fact, FactGrid, Section } from "@/components/section"
import { seriesColor } from "@/lib/palette"
import type { Reference } from "@/lib/types"

/** An example of the one line this whole service is built around. */
const EXAMPLE =
  ">>>      93.8 Mb/s    1225.3 intr/s     83937 intr.   0.00% mem. occupied  ;  1 min 13 s since run start <<<"

/**
 * What the numbers are and where they come from.
 *
 * Worth a screen of its own because the central claim of the page -- that
 * `intr/s` is the trigger rate -- is an interpretation, not a label the board
 * prints. Someone reading a rate off this page should be able to find out what
 * it is a rate *of* without asking anybody.
 */
export function ReferencePanel({ reference }: { reference: Reference | null }) {
  return (
    <Stack gap="xl">
      <Section
        title="The line this page is built on"
        description="A CoBo prints one periodic, quantitative line to its console. Everything on the chart comes from it, and nothing else on the console is parsed at all."
      >
        <Code block>{EXAMPLE}</Code>
        <Text size="sm" c="dimmed">
          Matched with the same regular expression as{" "}
          <span className="tabular">shift_service/minicom_monitor/cobo_rate_logger.py</span>, and
          written to CSV with that program's columns in its order — so the files are
          interchangeable.
        </Text>
      </Section>

      <Section title="The four numbers">
        {(reference?.channels ?? []).map((channel) => (
          <Paper key={channel.key} withBorder p="md" radius="md">
            <FactGrid>
              <Fact label="Name">
                <span
                  style={{
                    display: "inline-block",
                    width: 12,
                    height: 3,
                    borderRadius: 2,
                    marginRight: 8,
                    verticalAlign: "middle",
                    background: seriesColor(channel.index),
                  }}
                />
                {channel.label} ({channel.unit})
              </Fact>
              <Fact label="Column" mono>
                {channel.key}
              </Fact>
              <Fact label="What it is">{channel.description}</Fact>
            </FactGrid>
          </Paper>
        ))}
      </Section>

      <Section
        title="The two ways in"
        description="Both give the same lines; they differ in what they cost the console."
      >
        {(reference?.kinds ?? []).map((kind) => (
          <Paper key={kind.id} withBorder p="md" radius="md">
            <FactGrid>
              <Fact label={kind.label}>{kind.detail}</Fact>
            </FactGrid>
          </Paper>
        ))}
        <Text size="sm" c="dimmed">
          Linux will let two processes open the same tty and warns about neither; they then split
          the byte stream and both lose most of their lines. That is why a held port is refused
          rather than shared, and why the capture file exists.
        </Text>
      </Section>

      <Section title="What the mean is over">
        <Text size="sm">
          The average beside the chart is over <strong>every sample in the window on screen</strong>,
          computed on the server before the samples are reduced for drawing. That distinction is
          not pedantic: the chart keeps the highest and lowest of each interval, so an average of
          the points you can see would be an average of the peaks. The running average on the panel
          above is a different number — every rate line since the console was opened.
        </Text>
      </Section>
    </Stack>
  )
}
