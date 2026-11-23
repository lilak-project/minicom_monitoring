import type { ReactNode } from "react"

/** The board's two routine messages, each in its own colour wherever console text is shown:
 *  waiting for a trigger in cyan, the heartbeat in yellow (index.css). */
const ROUTINE = /(waiting for interrupt|sending heart ?beat)/i

export function paint(text: string): ReactNode {
  const parts = text.split(ROUTINE)
  if (parts.length === 1) return text
  return parts.map((part, i) =>
    i % 2 ? (
      <span key={i} className={/^waiting/i.test(part) ? "mc-msg-wait" : "mc-msg-beat"}>
        {part}
      </span>
    ) : (
      part
    ),
  )
}
