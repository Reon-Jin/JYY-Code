import { afterEach, describe, expect, it } from "vitest"
import {
  beginUIPerformanceStage,
  completeUIPerformanceStage,
  incrementUIPerformanceCounter,
  resetUIPerformanceForTests,
} from "./ui-performance"

afterEach(() => resetUIPerformanceForTests())

describe("ui performance instrumentation", () => {
  it("records each lifecycle stage once without exposing application data", () => {
    beginUIPerformanceStage("startup-bootstrap")
    completeUIPerformanceStage("startup-bootstrap")
    completeUIPerformanceStage("startup-bootstrap")

    const entries = performance
      .getEntriesByType("measure")
      .filter((entry) => entry.name === "jyycode:ui:startup-bootstrap")
    expect(entries).toHaveLength(1)
  })

  it("keeps aggregate counters separate from rendered content", () => {
    incrementUIPerformanceCounter("streaming-renders")
    incrementUIPerformanceCounter("streaming-renders", 2)
    expect(performance.getEntriesByType("measure")).toHaveLength(0)
  })
})
