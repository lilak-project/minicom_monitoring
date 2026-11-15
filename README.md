# minicom Monitoring

The CoBo serial console as a web page. It reads the same bytes `minicom -D
/dev/ttyUSB1` would show you, plots the trigger rate the board prints, and says
what that rate has averaged.

```bash
cd frontend && npm install && npm run build && cd ..
./start_server.sh              # http://<this-host>:8006
```

Also registered with the LILAK portal as **minicom**, which starts it on demand
at `<portal>/p/minicom/`.

## Control and monitoring

Two modes. **Monitor** shows every console, its rate chart, the raw lines and
the recorded runs; **Control** adds the Sources tab (add, edit consoles), Open
and Close, and recording (Record, New run, Stop; NEXT sets the next run's
label). Under the portal, control is for a portal manager or an admin of this
service (a grant with admin ticked, to the person or a group); everyone else
gets monitoring, and the server refuses their writes (`backend/app/access.py`,
checked by `backend/tools/check_access.py`). Run alone, everything is allowed.
The screens are drawn with the NEON kit (`../neon_ui`).

## What it is for

A CoBo prints one periodic, quantitative line to its console:

```
>>>      93.8 Mb/s    1225.3 intr/s     83937 intr.   0.00% mem. occupied  ;  1 min 13 s since run start <<<
```

`intr/s` is the **trigger rate** — one interrupt is one accepted trigger read
out of the board — and it is the number a shifter watches. In minicom it scrolls
past every few seconds and the only way to know the average is to remember it.

So: a chart of the rate against the clock, with the mean drawn across it, and
the raw console underneath. The other three numbers on the line ride along and
are one click away.

The mean is over **every sample in the window on screen**, computed before the
samples are reduced for drawing. That distinction is not pedantic — the chart
keeps the highest and lowest of each interval, so an average of the points you
can see would be an average of the peaks.

## The two ways in, and why there are two

```
                    ┌──────────────┐
   /dev/ttyUSB1 ────┤   minicom    ├──── -C capture.log ───┐
        │           └──────────────┘                       │
        │  the port, read directly                         │  the file it writes
        └──────────────────────► minicom_monitoring ◄──────┘
```

**Serial port.** Nothing between the board and the parser. But Linux lets two
processes open the same tty and warns about neither; they then split the byte
stream and both lose most of their lines. So a held port is refused, not shared.

**minicom capture file.** Start minicom as `minicom -D /dev/ttyUSB1 -C
capture.log` and it writes everything it shows to that file. This service
follows the file, which costs the console nothing and leaves minicom exactly as
it was. On this bench that is usually the right one, because somebody is usually
sitting at minicom.

Either way the numbers are identical; a capture is a *terminal* recording, so
its escape sequences are stripped before the line is matched.

### Finding out who has the port

Two checks, because neither is enough alone.

`/proc/<pid>/fd` names the process exactly, but only for processes this user can
see — and minicom here is started with `sudo`, so its file descriptors are
unreadable and the scan comes back empty on the one case that matters most.

The **UUCP lock file** covers that. minicom, `cu`, `screen` and `picocom` all
write `/run/lock/LCK..ttyUSB1` holding their pid before they open a port; it is
world-readable, so it sees the root minicom that the `/proc` scan cannot. This
service writes one itself while a port is open, so the exclusion runs both ways.
A lock naming a pid that no longer exists is reported as stale and taken over,
rather than making the port permanently unopenable.

## Recording

Reading and recording are separate. The chart and the console scrollback run
whenever a console is open; whether the rate lines are *also* being written to a
file is the recording state, and it has its own bar above the chart:

```
● Recording run 34   [412 rate lines] [1.1 h] [mean 2,580 intr/s]      Run [  ] (New run) (Stop)
  cobo_rate_ttyUSB1_34.csv · started 2026-09-01 01:12:16
```

**Opening a console starts recording it.** On a shift the failure that costs
something is forgetting to press record, not an extra file — and stopping is
free, because the chart carries on either way.

- **New run** closes the current file and opens the next number, which is what
  starting a new run on the DAQ means here. It is the button that gets used.
- The **Run** box is for making this service's numbering agree with the DAQ's.
  Type `34` and press New run (or Enter) and the file is
  `cobo_rate_ttyUSB1_34.csv`. Left empty it takes the next number.
- **Stop** closes the file. The console stays open and the chart keeps moving.

One row per *recording*, not per file: recording run 34 twice appends to the
same CSV and is two rows in the Runs tab, because they are two spans of time
with two summaries and averaging them together would be a different claim.

Run numbering is shared across consoles, not per console — a DAQ run number
names the run, so two boards recording run 34 land on `cobo_rate_ttyUSB0_34.csv`
and `cobo_rate_ttyUSB1_34.csv`. The next number clears both the index and any
run-numbered file already in the directory, so a log folder carried over from
another install does not get overwritten.

## Where the data goes

CSV in `backend/log/CSV/`, one file per run, flushed on every rate line — a
service killed mid-run keeps everything up to the last one. Its index entry is
then rebuilt from the file on the next start and marked `interrupted`, rather
than sitting there claiming to still be recording.

The columns are exactly the ones
`~/shift_service/minicom_monitor/cobo_rate_logger.py` has been writing since
June, in that order:

```
timestamp_utc,mbps,intr_per_s,total_intr,mem_occupied_pct,run_time,run_time_seconds,raw_line
```

so a file from either program opens in the other, and in whatever the analysis
already reads them with. The regular expression that produces them is that
file's, unchanged.

Samples also stay in memory, and a browser asks for the window its chart is
showing rather than for everything. Following a run that has been going for a
week costs the same as following one that started a minute ago.

## Configuration

Every setting is an environment variable; nothing is required.

| | |
|---|---|
| `MINICOM_DATA_DIR` | where `sources.json` lives (default `backend/data`) |
| `MINICOM_LOG_DIR` | root of the CSVs (default `backend/log`) |
| `MINICOM_BAUD` | default for a new serial console (default 115200) |
| `MINICOM_HISTORY_LIMIT` | samples held per channel (default 200 000) |
| `MINICOM_CONSOLE_LIMIT` | raw lines held per console (default 2 000) |
| `MINICOM_BROADCAST_INTERVAL` | seconds between status frames (default 0.5) |
| `MINICOM_CAPTURE_PATH` | placeholder offered when adding a capture source |

`data/sources.json` holds the consoles; `data/runs.json` is the run index.

Started by the portal, `PORTAL_DATA_ROOT` + `PORTAL_SERVICE` move all of the
state into `portal-data/minicom/` on their own — the manifest carries no
absolute data path.

Command-line shortcuts, each remembered so once is enough:

```bash
python run.py --capture /tmp/cobo.cap        # follow a capture file
python run.py --port-device /dev/ttyUSB1     # read the port directly
python run.py --port 8007
```

## The page

**Sources** — the consoles this service knows, the serial ports on this machine
and who has each one open, and the form that adds one.

**One tab per console** — the current rate and the mean, large; the chart, with
the mean dashed across it and a picker for the other three numbers; and the raw
console below it. Both halves are needed: the chart says what the rate has been
doing, the console says why. A run that dropped to zero looks the same on the
plot whether the board crashed, the trigger was disabled, or the cable came out.

**Runs** — every recording, with how long it ran, how many rate lines it caught
and what the trigger rate averaged, and the CSV to download. Any file in the log
directory that no recording accounts for is listed under it rather than hidden:
a file in that folder the page does not mention is a file somebody will assume
was lost.

**Reference** (the book icon) — what the numbers are, where they come from, and
what exactly the mean is over.

Tab colours: green while the board is printing, grey when the console is not
open, **red when it is open but has said nothing for a minute** — which is not
the same as a board that is idle, and is the case worth noticing.

## Related

- `../vacuum_monitoring` — same shape, same shell; the gauges rather than the
  console. Several components here are its components, copied rather than
  shared because the two services are deployed independently.
- `../minicom/run_minicom` — the one-line script this replaces the *watching*
  half of. Starting minicom by hand is still how you talk to the board.
- `~/shift_service/minicom_monitor` — the previous logger and web monitor
  (port 8090). Its parser and CSV schema are the ones used here.

## In the LILAK elog

This service answers the elog's service contract on **`POST /api/elog`** — the
same URL handles both the handshake (Discover) and every later data request.
`app/elog.py` holds it, with the field list at the top.

Register it once, in the elog's Experiment tab → New Service, with this URL:

```
portal://minicom/api/elog
```

`portal://` rather than a host and port: a portal-managed service's port is
picked from a pool when it starts and can differ after a restart, so a literal
`http://127.0.0.1:<port>` goes stale. elog resolves the scheme per call from
`$PORTAL_DATA_ROOT/minicom/.port` (`lilak_elog/backend/portal_peer.py`). Running
this service standalone instead, register its real address.

Press **Discover**: elog reads the field list back and builds a `"minicom Monitoring log"`
format from it. What it fills:

| | |
|---|---|
| `intr_per_s` | the last trigger rate the console printed |
| `intr_per_s_1min` | its mean over the last 60 seconds (`Source.mean_over`) |
| `console`, `run_time` | which console, and how long since the run started |
| `body` | every configured console, both rates each |

The 1-minute mean is a plain average over the window, so it can be checked by
hand against the console. An empty window reports null, not zero — a source
that has said nothing for a minute has no rate, and 0 would read as a beam
that stopped.

Two things about the field list. It is deliberately **fixed** — elog matches a
format by its field signature, so a list that changed with the hardware would
fork the format and last month's entries would stop lining up with this
month's. And elog gives up after **5 seconds**, with `mode: "realtime"`
repeating as often as twice a second, so the endpoint only ever reads state
this service already holds.
