import { url } from "@/lib/portal-base"

import type {
  Me,
  ConsoleResponse,
  LogList,
  Reference,
  RunEntry,
  RunList,
  SerialPort,
  SeriesResponse,
  SourceDraft,
  SourceList,
  SourceSnapshot,
} from "./types"

/** Error carrying the backend's message so the UI can show it verbatim. */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json()
    // FastAPI puts a string in `detail` for HTTPException and a list for
    // request-validation failures.
    if (typeof body?.detail === "string") return body.detail
    if (Array.isArray(body?.detail)) {
      return body.detail.map((item: { msg?: string }) => item.msg ?? "Invalid value").join("; ")
    }
  } catch {
    /* fall through to the status text */
  }
  return response.statusText || `Request failed (${response.status})`
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

interface WindowQuery {
  keys: string[]
  from?: number | null
  to?: number | null
  maxPoints?: number
  /** Aborts the request when a newer window supersedes this one. */
  signal?: AbortSignal
}

function windowSearch(query: WindowQuery): string {
  const params = new URLSearchParams()
  params.set("keys", query.keys.join(","))
  if (query.from != null) params.set("from", String(query.from))
  if (query.to != null) params.set("to", String(query.to))
  if (query.maxPoints != null) params.set("max_points", String(query.maxPoints))
  return `?${params.toString()}`
}

export const api = {
  /** Who is looking, and whether they may control. */
  me: () => request<Me>("/api/me"),

  /** Static: answers with nothing connected, so the page explains itself. */
  reference: () => request<Reference>("/api/reference"),

  listSources: () => request<SourceList>("/api/sources"),

  saveSource: (draft: SourceDraft) =>
    request<SourceList>("/api/sources", { method: "PUT", ...json(draft) }),

  removeSource: (id: string) =>
    request<void>(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),

  connect: (id: string) =>
    request<SourceSnapshot>(`/api/sources/${encodeURIComponent(id)}/connect`, { method: "POST" }),

  /** Empty the chart and reset the counts and means. */
  clear: (id: string) =>
    request<SourceSnapshot>(`/api/sources/${encodeURIComponent(id)}/clear`, { method: "POST" }),

  disconnect: (id: string) =>
    request<SourceSnapshot>(`/api/sources/${encodeURIComponent(id)}/disconnect`, { method: "POST" }),

  listPorts: () => request<SerialPort[]>("/api/ports"),

  /** The samples in a window, decimated, each with the mean of the window. */
  series: (id: string, query: WindowQuery) =>
    request<SeriesResponse>(`/api/sources/${encodeURIComponent(id)}/series${windowSearch(query)}`, {
      signal: query.signal,
    }),

  /** Raw console lines after `since` -- what minicom's screen would show. */
  console: (id: string, since: number, limit = 400) =>
    request<ConsoleResponse>(
      `/api/sources/${encodeURIComponent(id)}/console?since=${since}&limit=${limit}`,
    ),

  /** Begin a run file.  An empty run means "the next number". */
  startRecording: (id: string, run = "", note = "") =>
    request<RunEntry>(`/api/sources/${encodeURIComponent(id)}/recording/start`, {
      method: "POST",
      ...json({ run, note }),
    }),

  /** Close the run file.  The console keeps reading and charting. */
  startRun: (run = "", note = "") =>
    request<{ run: string; note: string; started_at: number }>(`/api/run/start`, { method: "POST", ...json({ run, note }) }),

  stopRun: () => request<{ run: string }>(`/api/run/stop`, { method: "POST" }),

  stopRecording: (id: string) =>
    request<RunEntry>(`/api/sources/${encodeURIComponent(id)}/recording/stop`, {
      method: "POST",
    }),

  listRuns: () => request<RunList>("/api/runs"),

  listLogs: () => request<LogList>("/api/logs"),

  // Used as an <a href download>, not fetched -- so it carries the prefix itself.
  logDownloadUrl: (filename: string) => url(`/api/logs/${encodeURIComponent(filename)}/download`),
}

/** Message the operator should actually read, from any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
