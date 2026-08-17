export type UIPerformanceStage =
  | "startup-bootstrap"
  | "workspace-chunk-ready"
  | "first-workspace-shell"
  | "first-conversation-paint"
  | "first-file-preview-ready"

type LongTaskEntry = { duration: number }

const prefix = "jyycode:ui:"
const startedStages = new Set<string>()
const completedStages = new Set<string>()
const counters = new Map<string, number>()
const longTasks: LongTaskEntry[] = []
let observer: PerformanceObserver | undefined
let reportTimer: number | undefined
let reportSent = false

function canMeasure() {
  return typeof performance !== "undefined" && typeof performance.mark === "function"
}

function markName(stage: string, suffix: "start" | "end") {
  return `${prefix}${stage}:${suffix}`
}

export function beginUIPerformanceStage(stage: string) {
  if (!canMeasure() || startedStages.has(stage)) return
  startedStages.add(stage)
  performance.mark(markName(stage, "start"))
}

export function completeUIPerformanceStage(stage: UIPerformanceStage) {
  if (!canMeasure() || completedStages.has(stage)) return
  beginUIPerformanceStage(stage)
  completedStages.add(stage)
  const end = markName(stage, "end")
  performance.mark(end)
  try {
    performance.measure(`${prefix}${stage}`, markName(stage, "start"), end)
  } catch {
    // Some embedded webviews expose mark but not measure; metrics remain optional.
  }
}

export function incrementUIPerformanceCounter(name: string, amount = 1) {
  counters.set(name, (counters.get(name) ?? 0) + amount)
}

function percentile(values: readonly number[], fraction: number) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function summary() {
  const measures = Object.fromEntries(
    (typeof performance === "undefined" ? [] : performance.getEntriesByType("measure"))
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => [entry.name.slice(prefix.length), Math.round(entry.duration)]),
  )
  return {
    measures,
    counters: Object.fromEntries(counters),
    startupRequests: typeof performance === "undefined" ? undefined : performance.getEntriesByType("resource").length,
    longTaskP95Ms: percentile(
      longTasks.map((entry) => entry.duration),
      0.95,
    ),
    heapUsedBytes:
      typeof performance !== "undefined" && "memory" in performance
        ? (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize
        : undefined,
  }
}

export function startUIPerformanceMonitor() {
  if (typeof PerformanceObserver === "function") {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ duration: entry.duration })
          if (longTasks.length > 128) longTasks.shift()
        }
      })
      observer.observe({ type: "longtask", buffered: true })
    } catch {
      observer = undefined
    }
  }

  return () => {
    observer?.disconnect()
    observer = undefined
    if (reportTimer !== undefined) window.clearTimeout(reportTimer)
    reportTimer = undefined
  }
}

export function scheduleUIPerformanceReport() {
  if (reportTimer !== undefined || reportSent || typeof window === "undefined") return
  reportTimer = window.setTimeout(() => {
    reportTimer = undefined
    if (reportSent) return
    reportSent = true
    const development = Boolean(import.meta.env?.DEV)
    if (!development && Math.random() >= 0.05) return
    // Deliberately report only aggregate timings and counters. Never include
    // message text, session identifiers, project paths, or request payloads.
    console.info("[jyycode/ui-performance]", summary())
  }, 5_000)
}

export function resetUIPerformanceForTests() {
  startedStages.clear()
  completedStages.clear()
  counters.clear()
  longTasks.length = 0
  reportSent = false
  if (reportTimer !== undefined && typeof window !== "undefined") window.clearTimeout(reportTimer)
  reportTimer = undefined
  if (typeof performance !== "undefined") {
    for (const entry of performance.getEntriesByType("measure")) {
      if (entry.name.startsWith(prefix)) performance.clearMeasures(entry.name)
    }
  }
}
