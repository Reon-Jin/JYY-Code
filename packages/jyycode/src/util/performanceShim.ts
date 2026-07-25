/**
 * Performance shim — replaces globalThis.performance to prevent JSC's C++ Vector
 * from growing without bound.
 *
 * In Bun, globalThis.performance is JSC's native Performance object. It stores
 * marks, measures, and resource timings in a C++ Vector that never shrinks even
 * after clearMarks(). Long-running sessions accumulate hundreds of MB of dead
 * capacity.
 *
 * This shim keeps performance.now() on the native object (fast, no memory cost)
 * but redirects mark/measure/getEntries operations to a plain JS Map that the GC
 * can reclaim.
 *
 * MUST be installed before React/OTel import — see index.ts first import.
 */

const original = globalThis.performance

const marks = new Map<string, number>()
const measures = new Map<string, { name: string; startTime: number; duration: number }>()

function now(): number {
  return original.now()
}

function mark(name: string): PerformanceMark {
  marks.set(name, now())
  return {
    name,
    entryType: "mark",
    startTime: marks.get(name)!,
    duration: 0,
  } as PerformanceMark
}

interface MeasureOptions {
  start?: number
  end?: number
  detail?: unknown
}

function measure(name: string, startMarkOrOptions?: string | MeasureOptions, endMark?: string): void {
  let startTime: number
  let duration: number

  if (typeof startMarkOrOptions === "string") {
    const start = marks.get(startMarkOrOptions)
    const end = endMark ? marks.get(endMark) : now()
    startTime = start ?? now()
    duration = (end ?? now()) - startTime
  } else if (startMarkOrOptions && typeof startMarkOrOptions === "object") {
    startTime = startMarkOrOptions.start ?? 0
    duration = (startMarkOrOptions.end ?? now()) - startTime
  } else {
    startTime = 0
    duration = now()
  }

  measures.set(name, { name, startTime, duration })
}

interface PerformanceEntryLike {
  readonly name: string
  readonly entryType: string
  readonly startTime: number
  readonly duration: number
}

function getEntriesByType(type: string): PerformanceEntryLike[] {
  if (type === "mark") {
    return [...marks.entries()].map(([name, startTime]) => ({
      name,
      entryType: "mark",
      startTime,
      duration: 0,
    }))
  }
  if (type === "measure") {
    return [...measures.values()].map((m) => ({
      name: m.name,
      entryType: "measure",
      startTime: m.startTime,
      duration: m.duration,
    }))
  }
  return []
}

function getEntriesByName(name: string, type?: string): PerformanceEntryLike[] {
  const entries = getEntriesByType(type ?? "mark").concat(type === undefined ? getEntriesByType("measure") : [])
  return entries.filter((e) => e.name === name)
}

function clearMarks(name?: string): void {
  if (name !== undefined) {
    marks.delete(name)
  } else {
    marks.clear()
  }
}

function clearMeasures(name?: string): void {
  if (name !== undefined) {
    measures.delete(name)
  } else {
    measures.clear()
  }
}

const shim = {
  now,
  mark,
  measure: measure as typeof performance.measure,
  getEntriesByType: getEntriesByType as typeof performance.getEntriesByType,
  getEntriesByName: getEntriesByName as typeof performance.getEntriesByName,
  clearMarks: clearMarks as typeof performance.clearMarks,
  clearMeasures: clearMeasures as typeof performance.clearMeasures,
  clearResourceTimings: (() => {}) as typeof performance.clearResourceTimings,
  setResourceTimingBufferSize: (() => {}) as typeof performance.setResourceTimingBufferSize,
  markResourceTiming: (() => {}) as any,
  get timeOrigin() {
    return original.timeOrigin
  },
  get onresourcetimingbufferfull() {
    return (original as any).onresourcetimingbufferfull
  },
  set onresourcetimingbufferfull(_v: any) {
    // no-op
  },
  toJSON() {
    return original.toJSON()
  },
} as unknown as typeof performance

export function installPerformanceShim(): void {
  if ((globalThis as any).__performanceShimInstalled) return
  ;(globalThis as any).__performanceShimInstalled = true
  globalThis.performance = shim
}

installPerformanceShim()
