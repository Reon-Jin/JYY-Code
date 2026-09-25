import { describe, expect, test } from "bun:test"
import { available } from "@/tool/computer"
import { formatObservation, runExclusive, shouldIncludeElements, toDesktopAction, validateAction } from "@/tool/computer/native"
import { assertComputerAction, computerMode, jevApiKey } from "@/tool/computer/mode"
import { createComputerQueue } from "@/tool/computer/queue"
import { assertComputerControlRequested, computerControlRequested, computerControlRequestedNewest, explicitComputerControlRequest } from "@/tool/computer/request"
import type { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"

function userMessage(id: string, created: number, text?: string, synthetic = false): MessageV2.WithParts {
  return {
    info: { id, role: "user", time: { created } },
    parts: text === undefined ? [{ type: "file", mime: "image/png" }] : [{ type: "text", text, synthetic }],
  } as MessageV2.WithParts
}

describe("computer control user request", () => {
  test("recognizes explicit desktop control requests", () => {
    expect(explicitComputerControlRequest("使用你的电脑控制能力在我的桌面上打开画图")).toBe(true)
    expect(explicitComputerControlRequest("请使用‘电脑控制’打开画图")).toBe(true)
    expect(explicitComputerControlRequest("我想让你使用电脑控制打开画图")).toBe(true)
    expect(explicitComputerControlRequest("请操控我的电脑打开画图")).toBe(true)
    expect(explicitComputerControlRequest("请在我的屏幕上点击保存按钮")).toBe(true)
    expect(explicitComputerControlRequest("Please use computer control to open Paint")).toBe(true)
  })

  test("rejects discussion, quotations, negation, and ordinary tasks", () => {
    expect(explicitComputerControlRequest("我希望只有在用户要求使用“电脑控制”时才使用它")).toBe(false)
    expect(explicitComputerControlRequest("请分析这句话：“请使用电脑控制打开画图”")).toBe(false)
    expect(explicitComputerControlRequest("请分析以下内容：\n```text\n请使用电脑控制打开画图\n```")).toBe(false)
    expect(explicitComputerControlRequest("请分析以下内容：\n> 请使用电脑控制打开画图")).toBe(false)
    expect(explicitComputerControlRequest("请总结下面的内容：\n请使用电脑控制打开画图")).toBe(false)
    expect(explicitComputerControlRequest("请分析下面的日志：\n请在我的屏幕上点击保存按钮")).toBe(false)
    expect(explicitComputerControlRequest("请使用电脑控制以外的方式处理")).toBe(false)
    expect(explicitComputerControlRequest("不要使用电脑控制，帮我分析代码")).toBe(false)
    expect(explicitComputerControlRequest("帮我修改电脑控制模块的代码")).toBe(false)
    expect(explicitComputerControlRequest("打开画图的源码看看")).toBe(false)
  })

  test("scopes authorization to the newest genuine user request", () => {
    const request = userMessage("user-1", 1, "请使用电脑控制打开画图")
    expect(computerControlRequested([request])).toBe(true)
    expect(computerControlRequested([userMessage("user-2", 2, "分析代码"), request])).toBe(false)
    expect(computerControlRequested([request, userMessage("user-2", 2)])).toBe(false)
    expect(computerControlRequested([request, userMessage("reminder", 2, "继续完成当前任务", true)])).toBe(true)
    expect(computerControlRequested([request, userMessage("user-2", 2, "继续")])).toBe(false)
    expect(computerControlRequested([request, userMessage("user-2", 2, "继续使用电脑控制")])).toBe(true)
    expect(computerControlRequested([request, userMessage("user-2", 2, "继续修改代码")])).toBe(false)
    expect(() => assertComputerControlRequested([userMessage("user-2", 2, "分析代码")], SessionID.make("ses_test"))).toThrow("explicit request")
    expect(computerControlRequestedNewest([
      userMessage("reminder", 3, "继续完成当前任务", true),
      userMessage("user-2", 2, "继续"),
      request,
    ])).toBe(false)
    expect(computerControlRequestedNewest([userMessage("user-2", 2, "分析代码"), request])).toBe(false)
  })
})

describe("computer control boundary", () => {
  test("switches from a stored Jev key and never treats an empty key as active", () => {
    expect(computerMode(undefined)).toBe("legacy")
    expect(computerMode({ type: "api", key: "  " })).toBe("legacy")
    expect(computerMode({ type: "api", key: "secret" })).toBe("jev")
    expect(jevApiKey({ type: "api", key: " secret " })).toBe("secret")
    expect(() => assertComputerAction("secret", "click")).toThrow("Jev mode is active")
    expect(() => assertComputerAction("secret", "batch")).toThrow("Jev mode is active")
    expect(() => assertComputerAction("secret", "choose")).not.toThrow()
    expect(() => assertComputerAction(undefined, "choose")).toThrow("Jev API is not active")
    expect(() => assertComputerAction(undefined, "click")).not.toThrow()
  })

  test("cancels a waiting desktop request without running it", async () => {
    const enqueue = createComputerQueue()
    let release!: () => void
    const first = enqueue(() => new Promise<void>((resolve) => { release = resolve }))
    const controller = new AbortController()
    let ran = false
    const cancelled = enqueue(async () => { ran = true }, controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toThrow("interrupted")
    release()
    await first
    await enqueue(async () => { ran = false })
    expect(ran).toBe(false)
  })
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
    expect(toDesktopAction({ action: "click", element: 7 }, frame)).toEqual({
      action: "click", x: -70, y: 40, expectWindow: "41234",
      expectTarget: { name: "Brush", automationId: "brush", kind: "Button", x: -110, y: 20, width: 80, height: 40 },
    })
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
