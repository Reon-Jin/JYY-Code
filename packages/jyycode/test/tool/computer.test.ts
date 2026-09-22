import { describe, expect, test } from "bun:test"
import { available } from "@/tool/computer"
import { formatObservation, runExclusive, validateAction } from "@/tool/computer/native"

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
  })

  test("reports desktop coordinates alongside scaled image dimensions", () => {
    const output = formatObservation({
      screen: { x: -1920, y: 0, width: 3840, height: 1080 },
      image: { width: 2000, height: 563 },
      cursor: { x: -100, y: 10 },
      window: "Editor",
      elements: [{
        index: 1, name: "Save", role: "Button", automationId: "save", x: -110, y: 20,
        width: 80, height: 40, enabled: true, focused: false, depth: 1,
      }],
    })
    expect(output).toContain("origin (-1920, 0)")
    expect(output).toContain("2000×563")
    expect(output).toContain("#1 Button \"Save\" at (-110,20) 80×40; center (-70,40) id=\"save\"")
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
