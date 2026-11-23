import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Tabs, type TabItem } from "@neon"

/**
 * The tab row, and when it is too long for the bar a key at its right end that
 * opens every tab at once below the bar -- name and state, a grid you can read --
 * instead of making you scroll the row sideways to find one.
 */
export function TabsWithMore({
  items,
  value,
  onChange,
}: {
  items: TabItem[]
  value: string
  onChange: (value: string) => void
}) {
  const wrap = useRef<HTMLDivElement | null>(null)
  const [hidden, setHidden] = useState(0)
  const [open, setOpen] = useState(false)

  // How many tabs do not fit, re-counted when the bar or the row changes.
  useLayoutEffect(() => {
    const nav = wrap.current?.querySelector<HTMLElement>(".neon-tabs")
    if (!nav) return
    const count = () => {
      const edge = nav.scrollLeft + nav.clientWidth
      setHidden([...nav.querySelectorAll<HTMLElement>(":scope > .neon-tab")].filter((t) => t.offsetLeft + t.offsetWidth > edge + 1).length)
    }
    count()
    const observer = new ResizeObserver(count)
    observer.observe(nav)
    nav.addEventListener("scroll", count)
    return () => {
      observer.disconnect()
      nav.removeEventListener("scroll", count)
    }
  }, [items.length])

  // Esc, or a press anywhere else, closes it.
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    const press = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("keydown", key)
    window.addEventListener("mousedown", press)
    return () => {
      window.removeEventListener("keydown", key)
      window.removeEventListener("mousedown", press)
    }
  }, [open])

  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
    // The picked tab scrolled into the row, so its underline is seen.
    requestAnimationFrame(() =>
      wrap.current?.querySelector(".neon-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    )
  }

  return (
    <div ref={wrap} className="mc-tabwrap">
      <Tabs items={items} value={value} onChange={pick} />
      {hidden > 0 || open ? (
        <button type="button" className={`mc-tabmore${open ? " on" : ""}`} onClick={() => setOpen(!open)} title="Every tab">
          {open ? "✕" : `+${hidden} ▾`}
        </button>
      ) : null}
      {open ? (
        <div className="mc-tabpanel">
          {items.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`mc-tabcell${item.value === value ? " on" : ""}`}
              onClick={() => pick(item.value)}
            >
              <span className="mc-tabcell-name">{item.label}</span>
              {item.state ? <span className={`mc-tabcell-state tone-text-${item.tone ?? "idle"}`}>{item.state}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
