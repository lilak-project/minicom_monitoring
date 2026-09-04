/**
 * The server's clock, as this browser can best tell it.
 *
 * Every timestamp the backend hands out — when a sample was taken, when a run
 * started — is on the server's clock, and the chart asks for its window in the
 * same numbers. A browser on another machine is a different clock, and on a
 * bench PC without NTP it can be minutes or hours out.
 *
 * That is not a cosmetic difference. `Date.now()` on a machine ten minutes
 * fast asks for the last ten minutes *of its own clock*, which is a window
 * entirely after the newest sample: the request succeeds, the answer is empty,
 * and the chart says "no rate lines in this window" while the console right
 * below it fills up — because the console is not filtered by time. The symptom
 * points nowhere near the cause.
 *
 * So the offset is measured from the status frames and applied wherever a
 * browser timestamp meets a server one. It is not smoothed or averaged: a
 * clock does not drift meaningfully between frames, and the latest reading is
 * the best one.
 */

let offset = 0

/** Told the server's time; the round trip is under a millisecond on a LAN. */
export function syncClock(serverTime: number): void {
  offset = serverTime - Date.now() / 1000
}

/** How far this browser's clock is from the server's, in seconds. */
export function clockOffset(): number {
  return offset
}

/** Unix seconds on the server's clock — the one every timestamp is in. */
export function now(): number {
  return Date.now() / 1000 + offset
}
