import { describe, expect, test } from "bun:test"
import { available } from "@/tool/computer"
import { formatObservation, runExclusive, shouldIncludeElements, toDesktopAction, validateAction } from "@/tool/computer/native"

describe("computer control boundary", () => {
  test("requires a Desktop single-Agent root session", () => {
    expect(available("desktop", { parentID: undefined, multiAgent: false })).toBe(true)
    expect(available("desktop", { parentID: undefined, multiAgent: undefined })).toBe(true)
    expect(available("desktop", { parentID: undefined, multiAgent: true })).toBe(false)
    expect(available("cli", { parentID: undefined, multiAgent: false })).toBe(false)
    expect(available("desktop", { parentID: "child" as never, multiAgent: false })).toBe(false)
  })

  test("rejects incomplete actions before invoking the operating system", () => {
    expect(() => validateAction({ action: "drag", x: 4, y: 5, toX: 20 })).toThrow("toY")
    expect(() => validateAction({ action: "click", x: 4 })).toThrow("together")
    expect(() => validateAction({ action: "scroll", direction: "down", amount: 0 })).toThrow("wheel steps")
    expect(() => validateAction({ action: "key", keys: "" })).toThrow("keys")
    expect(() => validateAction({ action: "batch", steps: [] })).toThrow("1 to 12")
    expect(() => validateAction({ action: "batch", steps: [{ action: "drag", x: 4, y: 5, toX: 20 }] })).toThrow("toY")
    expect(() => validateAction({ action: "batch", steps: [{ action: "wait", milliseconds: 5001 }] })).toThrow("5000")
    expect(() => validateAction({ action: "batch", steps: Array.from({ length: 4 }, () => ({ action: "wait", milliseconds: 2000 })) })).toThrow("6000")
    expect(() => validateAction({ action: "observe", annotate: "yes" as never })).toThrow("annotate")
    expect(() => validateAction({ action: "observe", resolution: "tiny" as never })).toThrow("resolution")
    expect(() => validateAction({ action: "click", element: 0 })).toThrow("element")
    expect(() => validateAction({ action: "click", element: 1, x: 4, y: 5 })).toThrow("element")
    expect(() => validateAction({ action: "drag", points: [{ x: 1, y: 2 }] })).toThrow("2 to 128")
    expect(() => validateAction({ action: "drag", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], x: 1, y: 2 })).toThrow("points")
    expect(() => validateAction({ action: "batch", steps: Array.from({ length: 4 }, () => ({ action: "drag", points: Array.from({ length: 128 }, (_, x) => ({ x, y: 2 })) })) })).toThrow("480")
    expect(() => validateAction({ action: "drag", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })).not.toThrow()
    expect(() => validateAction({ action: "wait", milliseconds: 2500, untilWindow: "画图" })).not.toThrow()
    expect(() => validateAction({ action: "wait", milliseconds: 5001, untilWindow: "画图" })).toThrow("5000")
    expect(() => validateAction({ action: "click", untilWindow: "画图" })).toThrow("untilWindow")
    expect(() => validateAction({ action: "batch", steps: [{ action: "click", x: 4, y: 5 }, { action: "type", text: "hi" }] })).not.toThrow()
  })

  test("reports screenshot coordinates and maps actions onto a negative-origin desktop", () => {
    const frame = {
      screen: { x: -1920, y: 0, width: 3840, height: 1080 },
      image: { width: 2000, height: 563 },
      cursor: { x: -100, y: 10 },
      window: "Editor",
      elements: [{
        index: 1, name: "Save", role: "Button", automationId: "save", x: -110, y: 20,
        width: 80, height: 40, enabled: true, focused: false, depth: 1,
      }],
    }
    const output = formatObservation(frame)
    expect(output).toContain("origin (0, 0)")
    expect(output).toContain("2000×563")
    expect(output).toContain("#1 Button \"Save\" at (943,10) 41×21; center (964,21) id=\"save\"")
    expect(toDesktopAction({ action: "click", x: 1000, y: 281 }, frame)).toEqual({ action: "click", x: 0, y: 539 })
    expect(toDesktopAction({ action: "batch", includeElements: true, resolution: "high", steps: [
      { action: "click", x: 1000, y: 281 },
      { action: "drag", x: 0, y: 0, toX: 1999, toY: 562 },
    ] }, frame)).toEqual({ action: "batch", includeElements: true, resolution: "high", steps: [
      { action: "click", x: 0, y: 539 },
      { action: "drag", x: -1920, y: 0, toX: 1918, toY: 1078 },
    ] })
    expect(formatObservation(frame, false)).toContain("Accessibility elements omitted for speed")
    expect(formatObservation(frame, false)).not.toContain("#1 Button")
    expect(() => toDesktopAction({ action: "click", x: 2000, y: 0 }, frame)).toThrow("outside")
  })

  test("targets accessibility centers and maps continuous drag paths without stale-window input", () => {
    const frame = {
      screen: { x: -1920, y: 0, width: 3840, height: 1080 },
      image: { width: 2000, height: 563 },
      cursor: { x: 0, y: 0 },
      window: "Paint",
      windowID: "41234",
      elements: [{
        index: 7, name: "Brush", role: "Button", automationId: "brush", x: -110, y: 20,
        width: 80, height: 40, enabled: true, focused: false, depth: 1,
      }],
    }
    expect(toDesktopAction({ action: "click", element: 7 }, frame)).toEqual({ action: "click", x: -70, y: 40, expectWindow: "41234" })
    expect(toDesktopAction({ action: "click", x: 1000, y: 281 }, frame)).toEqual({ action: "click", x: 0, y: 539, expectWindow: "41234" })
    expect(toDesktopAction({ action: "key", keys: "Enter" }, frame)).toEqual({ action: "key", keys: "Enter", expectWindow: "41234" })
    expect(toDesktopAction({ action: "type", text: "abc" }, frame)).toEqual({ action: "type", text: "abc", expectWindow: "41234" })
    expect(toDesktopAction({ action: "scroll", direction: "down", amount: 1 }, frame)).toEqual({ action: "scroll", direction: "down", amount: 1, expectWindow: "41234" })
    expect(toDesktopAction({ action: "drag", points: [{ x: 0, y: 0 }, { x: 1000, y: 281 }, { x: 1999, y: 562 }] }, frame)).toEqual({
      action: "drag", points: [{ x: -1920, y: 0 }, { x: 0, y: 539 }, { x: 1918, y: 1078 }], expectWindow: "41234",
    })
    expect(() => toDesktopAction({ action: "click", element: 8 }, frame)).toThrow("not in the latest observation")
    expect(() => toDesktopAction({ action: "drag", points: [{ x: 0, y: 0 }, { x: 2000, y: 0 }] }, frame)).toThrow("outside")
  })

  test("refreshes element maps after semantic clicks while keeping ordinary actions fast", () => {
    expect(shouldIncludeElements({ action: "observe" })).toBe(true)
    expect(shouldIncludeElements({ action: "click", element: 7 })).toBe(true)
    expect(shouldIncludeElements({ action: "batch", steps: [{ action: "click", element: 7 }] })).toBe(true)
    expect(shouldIncludeElements({ action: "drag", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })).toBe(false)
    expect(shouldIncludeElements({ action: "click", element: 7, includeElements: false })).toBe(false)
  })

  test("serializes actions and recovers after a failed action", async () => {
    const order: string[] = []
    const first = runExclusive(async () => {
      order.push("first-start")
      await Bun.sleep(10)
      order.push("first-end")
      throw new Error("first failed")
    })
    const second = runExclusive(async () => {
      order.push("second")
    })
    await expect(first).rejects.toThrow("first failed")
    await second
    expect(order).toEqual(["first-start", "first-end", "second"])
  })
})
