/** Shapes returned by the backend.  Kept in step with `backend/app/`. */

/** Where a console's bytes come from. */
export type SourceKind = "serial" | "capture"

/** The four numbers on a CoBo rate line, as `parser.py` names them. */
export type ChannelKey = "intr_per_s" | "mbps" | "mem_pct" | "total_intr"

/** One channel of one console, as it stands right now. */
export interface ChannelReading {
  key: ChannelKey
  index: number
  label: string
  unit: string
  value: number | null
  at: number | null
  points: number
  /** Samples that have aged out of the in-memory buffer. */
  dropped: number
  first_at: number | null
  last_at: number | null
}

/** Another process with a serial port open.  Two readers halve both. */
export interface Holder {
  pid: number
  command: string
  name: string
  /** How it was found. A `sudo` minicom's file descriptors are unreadable to
   *  this service, so its UUCP lock file is the only thing that sees it. */
  via: "open file descriptor" | "lock file"
  /** A lock file whose process is gone. Not a holder; it will be taken over. */
  stale: boolean
}

/** A console's settings and current reading.  Never its history. */
export interface SourceSnapshot {
  id: string
  name: string
  kind: SourceKind
  port: string
  baud: number
  path: string
  autostart: boolean
  /** Shown as a tile in the portal's live mode. */
  live: boolean
  /** The port or the path, whichever this one is. */
  origin: string
  status: "reading" | "stopped" | "error"
  last_error: string | null
  opened_at: number | null
  /** Console lines seen, of which `samples` were rate lines. */
  lines: number
  samples: number
  /** Lines that said they were rate lines and did not parse.  Should be 0. */
  unparsed: number
  last_unparsed: string | null
  /** The newest console line that is not a rate line, dashes dropped. */
  last_info: string | null
  last_info_at: number | null
  /** The trigger rate over the last ten minutes, a few points: an overview tile's trend. */
  trace: number[]
  /** Times the board's trigger count went backwards, i.e. a run started. */
  runs: number
  /** Mean trigger rate over everything heard since this console was opened. */
  session_mean: number | null
  run_time: string | null
  run_time_seconds: number | null
  last_sample_at: number | null
  channels: ChannelReading[]
  /** The run being written now, or null when this console is not recording. */
  recording: RunEntry | null
  /** What an unnumbered new run would be called: one past the highest taken. */
  next_run: string
  /** The run every open console records to, or null between runs. */
  current_run: { run: string; note: string; started_at: number; daq: string | null } | null
  /** Runs started and stopped by the GANIL DAQ (follow.py); error = why it cannot ask. */
  follow_daq: { on: boolean; error: string | null; daq: DaqSummary | null }
  held_by: Holder[]
}

/** One recording: a span of console output written to one run file. */
export interface RunEntry {
  id: string
  source_id: string
  source_name: string
  origin: string
  /** The run label — the DAQ's run number, normally. */
  run: string
  filename: string
  path: string
  started_at: number
  stopped_at: number | null
  note: string
  /** This recording added to a file an earlier one had already made. */
  appended: boolean
  /** The service was killed mid-run; the summary was rebuilt from the file. */
  interrupted: boolean
  rows: number
  first_at: number | null
  last_at: number | null
  /** Trigger rate over the whole recording. */
  mean: number | null
  min: number | null
  max: number | null
  running: boolean
  seconds: number | null
}

export interface RunList {
  csv_dir: string
  columns: string[]
  next_run: string
  runs: RunEntry[]
  /** CSVs in the directory that no recording accounts for. */
  unlisted: LogEntry[]
}

export interface SourceList {
  started_at: number
  default_max_points: number
  /** The server's clock. Every timestamp in this response is on it. */
  server_time: number
  sources: SourceSnapshot[]
}

/** Everything about a window that is not the samples themselves. */
export interface SeriesStats {
  mean: number | null
  min: number | null
  max: number | null
  stdev: number | null
  /** Samples in the window, before decimation. */
  count: number
}

/** One channel's samples over a window, as uPlot wants them: parallel arrays. */
export interface SeriesChannel {
  key: ChannelKey
  index: number
  label: string
  unit: string
  t: number[]
  v: number[]
  total: number
  decimated: boolean
  stats: SeriesStats
}

export interface SeriesResponse {
  id: string
  name: string
  start: number | null
  end: number | null
  max_points: number
  series: SeriesChannel[]
}

export interface ConsoleLine {
  seq: number
  at: number
  text: string
}

export interface ConsoleResponse {
  id: string
  since: number
  /** Ask from this next. */
  latest: number
  /** True when lines were missed between `since` and the first one here. */
  gap: boolean
  lines: ConsoleLine[]
}

export interface SerialPort {
  device: string
  description: string
  hwid: string
  serial_number: string | null
  /** False for the built-in /dev/ttyS* lines with nothing on them. */
  physical: boolean
  held_by: Holder[]
}

export interface ChannelSpec {
  key: ChannelKey
  index: number
  label: string
  unit: string
  description: string
}

export interface KindSpec {
  id: SourceKind
  label: string
  detail: string
}

export interface Reference {
  primary: ChannelKey
  channels: ChannelSpec[]
  baud_rates: number[]
  default_capture_path: string
  kinds: KindSpec[]
}

export interface LogEntry {
  filename: string
  size: number
  modified: number
}

export interface LogList {
  csv_dir: string
  columns: string[]
  logs: LogEntry[]
}

/** The body of a PUT /api/sources. */
export interface SourceDraft {
  id?: string
  name: string
  kind: SourceKind
  port?: string
  baud?: number
  path?: string
  autostart?: boolean
  live?: boolean
}

/** /api/me: who is looking, and whether they may control. */
export interface Me {
  name: string | null
  control: boolean
  /** Run without a portal: nobody to ask, so control is allowed. */
  standalone: boolean
}

/** What ganil_daq_monitoring last said, as follow.py keeps it. */
export interface DaqSummary {
  live: { run: number; note: string; elapsed_s: number; size: number; storage_off: boolean } | null
  daq_up: boolean
  rate_bytes_per_s: number | null
  down: string[]
  components: number
}
