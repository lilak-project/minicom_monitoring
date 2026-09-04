import { useCallback, useEffect, useRef, useState } from "react"

import { api } from "@/lib/api"
import { clockOffset, syncClock } from "@/lib/clock"
import { BASE } from "@/lib/portal-base"
import type { SourceSnapshot } from "@/lib/types"

interface StatusFrame {
  type: "status"
  /** The server's clock, which every timestamp below is on. */
  server_time: number
  sources: SourceSnapshot[]
}

export interface StatusStream {
  sources: SourceSnapshot[]
  /** True while the socket is open, i.e. the readouts are current. */
  live: boolean
  /** Seconds this browser's clock is ahead of the server's. */
  offset: number
  /** Fetch the list now, without waiting for the next frame. */
  refresh: () => void
}

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:"
  // BASE is "" served directly; behind the portal the socket must go through
  // the same `/p/<name>` prefix -- the portal proxies WebSockets there too.
  return `${scheme}//${window.location.host}${BASE}/ws/status`
}

/**
 * Subscribe to the backend's status broadcast.
 *
 * Only the current reading of each console comes down this socket -- history
 * is a query against a window. So a browser following a run that has been
 * going for a week costs the same as one following a run that started a minute
 * ago. Reconnects on its own with a capped backoff after a drop.
 */
export function useStatusStream(): StatusStream {
  const [sources, setSources] = useState<SourceSnapshot[]>([])
  const [live, setLive] = useState(false)
  const [offset, setOffset] = useState(0)
  const retryRef = useRef(0)

  useEffect(() => {
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const connect = () => {
      socket = new WebSocket(socketUrl())

      socket.onopen = () => {
        retryRef.current = 0
        setLive(true)
      }

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as StatusFrame
          if (message.type !== "status") return
          // Before the sources: the chart's window is computed from this, and
          // a frame that set the data first would render one tick against the
          // wrong clock.
          if (Number.isFinite(message.server_time)) {
            syncClock(message.server_time)
            setOffset(clockOffset())
          }
          setSources(message.sources)
        } catch {
          /* a malformed frame is not worth tearing the socket down for */
        }
      }

      socket.onclose = () => {
        setLive(false)
        if (closed) return
        // 0.5s, 1s, 2s, 4s, capped at 5s.
        const delay = Math.min(500 * 2 ** retryRef.current, 5000)
        retryRef.current += 1
        retryTimer = setTimeout(connect, delay)
      }

      socket.onerror = () => socket?.close()
    }

    connect()
    return () => {
      closed = true
      clearTimeout(retryTimer)
      socket?.close()
    }
  }, [])

  // Adding or removing a console changes the tab row, and waiting up to one
  // broadcast interval for it to appear reads as the button not having worked.
  // The socket would deliver the same thing a moment later; this is only ever
  // early, never a second source of truth.
  const refresh = useCallback(() => {
    void api
      .listSources()
      .then((data) => {
        if (Number.isFinite(data.server_time)) {
          syncClock(data.server_time)
          setOffset(clockOffset())
        }
        setSources(data.sources)
      })
      .catch(() => undefined)
  }, [])

  // Once on mount as well: the first chart window is computed within a couple
  // of hundred milliseconds, and waiting for the socket to say what time it is
  // would draw that one against the browser's clock.
  useEffect(refresh, [refresh])

  return { sources, live, offset, refresh }
}
