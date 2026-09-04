import { useCallback, useEffect, useRef, useState } from "react"

import { api, errorMessage } from "@/lib/api"
import type { ConsoleLine } from "@/lib/types"

/** Lines held in the browser.  The server's ring is larger; this is a screen. */
const KEEP = 600

/** A console is quiet for seconds and then prints a burst; a second is prompt. */
const POLL_MS = 1000

export interface ConsoleState {
  lines: ConsoleLine[]
  error: string | null
  /** True when lines were produced faster than they were fetched. */
  gap: boolean
  clear: () => void
}

/**
 * The raw console, polled.
 *
 * Polled rather than pushed: the lines carry a sequence number, so one small
 * request either way fetches exactly what this browser has not seen, and a tab
 * left in the background costs nothing while it is not asking. A socket per
 * console would be a second connection per browser to keep alive for a stream
 * that is silent most of the time.
 *
 * `enabled` is false while the console is not on screen -- there is no point
 * accumulating scrollback for a panel nobody is looking at, and the server's
 * own ring is what holds the history either way.
 */
export function useConsole(sourceId: string | null, enabled: boolean): ConsoleState {
  const [lines, setLines] = useState<ConsoleLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [gap, setGap] = useState(false)
  const sinceRef = useRef(0)

  // A different console is a different scrollback; nothing carries over.
  useEffect(() => {
    sinceRef.current = 0
    setLines([])
    setGap(false)
    setError(null)
  }, [sourceId])

  useEffect(() => {
    if (!sourceId || !enabled) return
    let stopped = false

    const tick = async () => {
      try {
        const response = await api.console(sourceId, sinceRef.current)
        if (stopped) return
        sinceRef.current = response.latest
        if (response.gap) setGap(true)
        if (response.lines.length > 0) {
          setLines((current) => [...current, ...response.lines].slice(-KEEP))
        }
        setError(null)
      } catch (err) {
        if (!stopped) setError(errorMessage(err))
      }
    }

    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [sourceId, enabled])

  const clear = useCallback(() => {
    setLines([])
    setGap(false)
  }, [])

  return { lines, error, gap, clear }
}
