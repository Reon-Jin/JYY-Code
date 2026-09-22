import { describe, expect, test } from "bun:test"
import { available } from "@/tool/computer"
import { formatObservation, runExclusive, toDesktopAction, validateAction } from "@/tool/computer/native"

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
    expect(() => validateAction({ action: "batch", steps: [{ action: "wait", milliseconds: 2001 }] })).toThrow("2000")
    expect(() => validateAction({ action: "batch", steps: Array.from({ length: 4 }, () => ({ action: "wait", milliseconds: 2000 })) })).toThrow("6000")
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
    expect(toDesktopAction({ action: "batch", steps: [
      { action: "click", x: 1000, y: 281 },
      { action: "drag", x: 0, y: 0, toX: 1999, toY: 562 },
    ] }, frame)).toEqual({ action: "batch", steps: [
      { action: "click", x: 0, y: 539 },
      { action: "drag", x: -1920, y: 0, toX: 1918, toY: 1078 },
    ] })
    expect(() => toDesktopAction({ action: "click", x: 2000, y: 0 }, frame)).toThrow("outside")
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
