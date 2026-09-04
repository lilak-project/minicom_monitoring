import { useCallback, useEffect, useRef, useState } from "react"

import { api, errorMessage } from "@/lib/api"
import type { ChannelKey, SeriesChannel } from "@/lib/types"
import type { TimeWindow } from "@/components/chart/use-time-range"

export interface SeriesState {
  channel: SeriesChannel | null
  loading: boolean
  error: string | null
  /** Add a sample that arrived on the status socket. */
  push: (at: number, value: number | null) => void
  refresh: () => void
}

/** Wait this long after the last window change before asking the server. */
const DEBOUNCE_MS = 120

/**
 * Fetch this much more than the chart is showing, on each side.
 *
 * Without it a zoom-out is a visible stutter: the axis widens at once, the
 * samples for the wider window have not arrived, and for a moment the trace is
 * squeezed into the middle of an empty chart. Half a window of margin either
 * side means the data for a zoom-out of up to 2x, or a pan of up to half a
 * screen, is already in the browser.
 */
const MARGIN = 0.5

/** However live the chart is, re-read the whole window this often. */
const RESYNC_MS = 20_000

/**
 * The samples for one chart window.
 *
 * Two things feed it. The window itself is a query -- pan or zoom and the
 * server answers with the samples inside the new bounds, already decimated and
 * carrying the mean of every sample in them. Between those, a live chart is
 * kept current by pushing the readings arriving on the status socket straight
 * onto the end, which costs no request at all.
 *
 * The two are reconciled every twenty seconds by re-reading the window, so a
 * chart left running overnight cannot drift away from the log on disk -- and
 * so the mean, which the pushed samples deliberately do not update, is never
 * more than that stale.
 */
export function useSeries(
  sourceId: string | null,
  channelKey: ChannelKey,
  window: TimeWindow,
  options: { maxPoints?: number; follow?: boolean } = {},
): SeriesState {
  const { maxPoints = 2000, follow = false } = options

  const [channel, setChannel] = useState<SeriesChannel | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Responses can come back out of order after a fast drag; only the newest
  // request is allowed to set the data.
  const requestRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(
    async (from: number, to: number) => {
      if (!sourceId) return
      const request = ++requestRef.current
      // Superseded work is cancelled rather than merely ignored.
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setLoading(true)
      try {
        const margin = (to - from) * MARGIN
        const response = await api.series(sourceId, {
          keys: [channelKey],
          from: from - margin,
          to: to + margin,
          // The margin is data the chart may need but is not showing, so the
          // resolution of what *is* on screen must not pay for it.
          maxPoints: Math.round(maxPoints * (1 + 2 * MARGIN)),
          signal: controller.signal,
        })
        if (request !== requestRef.current) return
        setChannel(response.series[0] ?? null)
        setError(null)
      } catch (err) {
        // An abort is this hook replacing its own request, not a failure.
        if (request !== requestRef.current || controller.signal.aborted) return
        setError(errorMessage(err))
      } finally {
        if (request === requestRef.current) setLoading(false)
      }
    },
    [sourceId, channelKey, maxPoints],
  )

  const windowRef = useRef(window)
  windowRef.current = window

  // While following, the right edge moves every second and refetching that
  // often would be pointless -- the socket is already delivering those
  // samples. So only a change of *width* is a new query; the timer below keeps
  // it honest. Three significant figures, because the All preset's width grows
  // by a second every second and an exact key would refetch continuously.
  const bucket = follow
    ? `follow:${(window.to - window.from).toPrecision(3)}`
    : `fixed:${window.from.toFixed(1)}:${window.to.toFixed(1)}`

  useEffect(() => {
    if (!sourceId) {
      setChannel(null)
      return
    }
    const { from, to } = windowRef.current
    const timer = setTimeout(() => void load(from, to), DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `bucket` is the debounced identity of the window; see above.
  }, [bucket, sourceId, load])

  useEffect(() => {
    if (!sourceId || !follow) return
    const timer = setInterval(() => {
      const { from, to } = windowRef.current
      void load(from, to)
    }, RESYNC_MS)
    return () => clearInterval(timer)
  }, [sourceId, follow, load])

  const push = useCallback((at: number, value: number | null) => {
    setChannel((current) => {
      if (current === null || value == null || !Number.isFinite(value)) return current
      const last = current.t[current.t.length - 1]
      if (last !== undefined && at <= last) return current
      // The trace advances; the stats deliberately do not. Recomputing a mean
      // from the decimated points on screen would be a different number from
      // the one the server sent, and it would drift further with every push.
      // The resync above replaces both together.
      return { ...current, t: [...current.t, at], v: [...current.v, value] }
    })
  }, [])

  const refresh = useCallback(() => {
    const { from, to } = windowRef.current
    void load(from, to)
  }, [load])

  return { channel, loading, error, push, refresh }
}
