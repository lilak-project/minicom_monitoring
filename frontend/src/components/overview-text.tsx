import { useEffect, useRef } from "react"

import { useConsole } from "@/hooks/use-console"
import { formatClock } from "@/lib/time"
import type { SourceSnapshot } from "@/lib/types"

/** Lines a card keeps; it shows the newest that fit and scrolls for the rest. */
const KEEP = 200

/**
 * One console as text, for the All tab's text mode: what minicom's screen (or the
 * capture file) says, the newest at the bottom. It follows the tail unless you
 * scroll up; the name opens the console's own tab.
 */
export function TextCard({
  source,
  className,
  onPick,
}: {
  source: SourceSnapshot
  className: string
  onPick: () => void
}) {
  const { lines, error } = useConsole(source.id, true)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const follow = useRef(true)
  useEffect(() => {
    const box = boxRef.current
    if (box && follow.current) box.scrollTop = box.scrollHeight
  }, [lines])
  const shown = lines.slice(-KEEP)
  return (
    <section className={`mc-textcard ${className}`}>
      <button type="button" className="mc-textcard-head" onClick={onPick}>
        <span className="mc-textcard-name">{source.name}</span>
        {/* The file (or port) by its own name; the whole path is on hover. */}
        <span className="mc-textcard-from" title={source.origin}>
          {source.origin.split("/").pop()}
        </span>
      </button>
      <div
        ref={boxRef}
        className="console-box mc-textcard-box"
        onScroll={(e) => {
          const b = e.currentTarget
          follow.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24
        }}
      >
        {error ? (
          <div className="console-line mc-textcard-error">{error}</div>
        ) : shown.length === 0 ? (
          <div className="console-line console-time">nothing yet</div>
        ) : (
          shown.map((line) => (
            <div key={line.seq} className={line.text.includes(">>>") ? "console-line is-rate" : "console-line"}>
              <span className="console-time">{formatClock(line.at)}</span>
              <span>{line.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
