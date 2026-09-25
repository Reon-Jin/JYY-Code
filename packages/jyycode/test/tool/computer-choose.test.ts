import { describe, expect, test } from "bun:test"
import { selectJev } from "@/tool/computer/jev"
import { candidateToNative, runChoose } from "@/tool/computer/choose"
import { createFrame } from "@/tool/computer/frame"
import type { Action, Observation } from "@/tool/computer/native"
import type { CandidateSet } from "@/tool/computer/candidate"

const candidates: CandidateSet = {
  frameID: "frame-1", truncated: false, total: 1,
  items: [{
    id: "c1", frameID: "frame-1", action: "click", targetID: "t1", label: "保存", kind: "button",
    box: { x: 100, y: 60, width: 100, height: 40 }, point: { x: 150, y: 80 }, sources: ["uia", "detector"],
  }],
}

function answer(choice: string, confidence = 0.9, probability = 0.95) {
  return { model: "jev-1.13.0", answers: { next: { type: "choice", choice, confidence, probabilities: { [choice]: probability } } } }
}

describe("Jev closed desktop decision", () => {
  test("selects a whole action and coordinate candidate from the TypeSafe endpoint", async () => {
    let request: unknown
    const server = Bun.serve({ port: 0, fetch: async (incoming) => {
      request = await incoming.json()
      return Response.json(answer("c1"))
    } })
    try {
      const decision = await selectJev({ intent: "点击保存", window: "Editor", candidates, apiKey: "test", endpoint: server.url.toString() })
      expect(decision).toMatchObject({ status: "selected", candidate: { action: "click", point: { x: 150, y: 80 } } })
      expect(request).toMatchObject({ model: "jev-1.13.0", questions: { next: { type: "choice" } } })
      expect(JSON.stringify(request)).not.toContain("literalText")
    } finally { server.stop() }
  })

  test("rejects unknown ids, low confidence and invalid coordinates", async () => {
    const fake = (value: unknown) => async () => Response.json(value)
    const base = { intent: "保存", window: "Editor", candidates, apiKey: "test" }
    expect(await selectJev({ ...base, fetcher: fake(answer("unknown")) })).toEqual({ status: "needs_vision", reason: "invalid_response" })
    expect(await selectJev({ ...base, fetcher: fake(answer("c1", 0.3, 0.9)) })).toEqual({ status: "needs_vision", reason: "low_confidence" })
    const invalid = { ...candidates, items: [{ ...candidates.items[0]!, point: { x: 300, y: 80 } }] }
    expect(await selectJev({ ...base, candidates: invalid, fetcher: fake(answer("c1")) })).toEqual({ status: "needs_vision", reason: "invalid_response" })
  })

  test("returns immediately for missing credentials, empty candidates and server failure", async () => {
    const noKey = await selectJev({ intent: "保存", window: "Editor", candidates, apiKey: "" })
    expect(noKey).toEqual({ status: "needs_vision", reason: "missing_key" })
    const empty = await selectJev({ intent: "保存", window: "Editor", candidates: { ...candidates, items: [] }, apiKey: "test" })
    expect(empty).toEqual({ status: "needs_vision", reason: "no_candidates" })
    const failure = await selectJev({ intent: "保存", window: "Editor", candidates, apiKey: "test", fetcher: async () => new Response("rate limit", { status: 429 }) })
    expect(failure).toEqual({ status: "needs_vision", reason: "unavailable" })
  })
})

describe("grounded desktop action execution", () => {
  const observation = (id: string): Observation => ({
    screen: { x: -1920, y: 0, width: 1920, height: 1080 },
    image: { width: 1280, height: 720 }, rawImage: { width: 1920, height: 1080 },
    cursor: { x: 0, y: 0 }, window: "Editor", windowID: "42", frameID: id, capturedAt: 123,
    elements: [{ index: 1, name: "保存", role: "Button", automationId: "save", x: -1820, y: 60,
      width: 100, height: 40, enabled: true, focused: false, depth: 1 }],
  })
  const selected: typeof selectJev = async ({ candidates: offered }) => ({
    status: "selected", candidate: offered.items[0]!, confidence: 0.91,
  })

  test("chooses a raw-pixel point with an atomic native accessibility target guard", async () => {
    const actions: Action[] = []
    const native = (async (action: Action) => {
      actions.push(action)
      const index = actions.length
      return { observation: observation(`f${index}`), png: Buffer.from([index]),
        rawPng: action.captureRaw ? Buffer.from([10, 20, 30]) : undefined }
    }) as typeof import("@/tool/computer/native").runNative
    const result = await runChoose({ intent: "点击保存", allowedActions: ["click"] }, undefined, {
      native, select: selected, parser: { health: async () => ({ ready: true }), parse: async () => { throw new Error("detector should not run") }, close: async () => undefined },
    })
    expect(result.status).toBe("executed")
    expect(actions.map((action) => action.action)).toEqual(["observe", "click"])
    expect(actions[1]).toMatchObject({ action: "click", x: -1770, y: 80, expectWindow: "42",
      expectTarget: { name: "保存", automationId: "save", x: -1820, y: 60, width: 100, height: 40 } })
  })

  test("does not send input when screenshot changed before execution", async () => {
    const actions: Action[] = []
    const native = (async (action: Action) => {
      actions.push(action)
      return { observation: { ...observation(`f${actions.length}`), elements: [] }, png: Buffer.from([actions.length]),
        rawPng: Buffer.from([actions.length]) }
    }) as typeof import("@/tool/computer/native").runNative
    const parser = { health: async () => ({ ready: true }), close: async () => undefined,
      parse: async (visualFrame: { id: string }) => ({ frameID: visualFrame.id,
        boxes: [{ x: 100, y: 60, width: 100, height: 40, confidence: 0.9, source: "detector" as const }], inferMs: 1, totalMs: 1 }) }
    const result = await runChoose({ intent: "点击左上角图标", allowedActions: ["click"] }, undefined, { native, select: selected, parser })
    expect(result).toMatchObject({ status: "needs_vision", reasonCode: "stale_frame" })
    expect(actions.map((action) => action.action)).toEqual(["observe", "observe"])
  })

  test("does not click an unlabeled detector box for a semantic intent Jev cannot see", async () => {
    const actions: Action[] = []
    const native = (async (action: Action) => {
      actions.push(action)
      return { observation: { ...observation(`f${actions.length}`), elements: [] },
        png: Buffer.from([1]), rawPng: Buffer.from([1]) }
    }) as typeof import("@/tool/computer/native").runNative
    const parser = { health: async () => ({ ready: true }), close: async () => undefined,
      parse: async (visualFrame: { id: string }) => ({ frameID: visualFrame.id,
        boxes: [{ x: 100, y: 60, width: 100, height: 40, confidence: 0.9, source: "detector" as const }], inferMs: 1, totalMs: 1 }) }
    const result = await runChoose({ intent: "点击保存图标", allowedActions: ["click"] }, undefined, { native, parser, select: selected })
    expect(result).toMatchObject({ status: "needs_vision", reasonCode: "unlabeled_target" })
    expect(actions.map((action) => action.action)).toEqual(["observe"])
  })

  test("uses the host-owned candidate even if a selector returns mutated coordinates", async () => {
    const actions: Action[] = []
    const native = (async (action: Action) => {
      actions.push(action)
      return { observation: observation(`f${actions.length}`), png: Buffer.from([actions.length]), rawPng: Buffer.from([1]) }
    }) as typeof import("@/tool/computer/native").runNative
    const malicious: typeof selectJev = async ({ candidates: offered }) => ({
      status: "selected", candidate: { ...offered.items[0]!, point: { x: 999, y: 999 } }, confidence: 1,
    })
    const result = await runChoose({ intent: "点击保存", allowedActions: ["click"] }, undefined, { native, select: malicious })
    expect(result.status).toBe("executed")
    expect(actions[1]).toMatchObject({ action: "click", x: -1770, y: 80 })
  })

  test("returns a fresh screenshot when the native hit test finds an overlay", async () => {
    const actions: Action[] = []
    const native = (async (action: Action) => {
      actions.push(action)
      if (action.action === "click") throw new Error("Target at coordinate changed or is covered; observe again")
      return { observation: observation(`f${actions.length}`), png: Buffer.from([actions.length]), rawPng: Buffer.from([1]) }
    }) as typeof import("@/tool/computer/native").runNative
    const result = await runChoose({ intent: "点击保存", allowedActions: ["click"] }, undefined, { native, select: selected })
    expect(result).toMatchObject({ status: "needs_vision", reasonCode: "target_changed" })
    expect(actions.map((action) => action.action)).toEqual(["observe", "click", "observe"])
  })

  test("keeps OCR off the fast detector path and crops it only after abstaining", async () => {
    const actions: Action[] = []
    const native = (async (action: Action) => {
      actions.push(action)
      return { observation: { ...observation(`f${actions.length}`), elements: [] },
        png: Buffer.from([actions.length]), rawPng: Buffer.from([1, 2, 3]) }
    }) as typeof import("@/tool/computer/native").runNative
    let ocrCalls = 0
    let choices = 0
    const parser = { health: async () => ({ ready: true }), close: async () => undefined,
      parse: async (visualFrame: { id: string }) => ({ frameID: visualFrame.id,
        boxes: [{ x: 1400, y: 60, width: 100, height: 40, confidence: 0.8, source: "detector" as const }], inferMs: 1, totalMs: 1 }) }
    const choose: typeof selectJev = async ({ candidates: offered }) => {
      choices++
      return choices === 1 ? { status: "needs_vision", reason: "abstained" } :
        { status: "selected", candidate: offered.items[0]!, confidence: 0.91 }
    }
    const result = await runChoose({ intent: "点击右上角保存", allowedActions: ["click"] }, undefined, {
      native, parser, select: choose,
      ocr: async (_frame, _signal, region) => {
        ocrCalls++
        expect(region).toEqual({ x: 960, y: 0, width: 960, height: 540 })
        return [{ text: "保存", box: { x: 1410, y: 65, width: 50, height: 20 }, confidence: 0.9 }]
      },
    })
    expect(result.status).toBe("executed")
    expect(ocrCalls).toBe(1)
    expect(choices).toBe(2)
    expect(actions.map((action) => action.action)).toEqual(["observe", "observe", "click"])
  })

  test("maps every offered action type through the same raw coordinate transform", () => {
    const frame = createFrame({ id: "f1", capturedAt: 123,
      screen: { x: -1920, y: 0, width: 1920, height: 1080 },
      rawImageSize: { width: 1920, height: 1080 }, displayImageSize: { width: 1280, height: 720 },
      monitors: [], foregroundWindow: { id: "42", title: "Editor" } })
    const base = candidates.items[0]!
    expect(candidateToNative({ ...base, frameID: "f1", action: "right_click" }, frame)).toMatchObject({ action: "click", button: "right", x: -1770, y: 80 })
    expect(candidateToNative({ ...base, frameID: "f1", action: "double_click" }, frame)).toMatchObject({ action: "click", double: true, x: -1770, y: 80 })
    expect(candidateToNative({ ...base, frameID: "f1", action: "type", literalText: "abc" }, frame)).toMatchObject({
      action: "batch", steps: [{ action: "click", x: -1770, y: 80 }, { action: "type", text: "abc" }],
    })
    expect(() => candidateToNative(base, frame)).toThrow("old frame")
  })
})
