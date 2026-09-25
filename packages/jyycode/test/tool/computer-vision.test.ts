import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { imageTiles, LocalVisualParser, normalizeVisualBoxes, parseTiled, type VisualParser, VisionUnavailableError } from "@/tool/computer/vision"
import { fuseTargets } from "@/tool/computer/fuse"
import { buildCandidates } from "@/tool/computer/candidate"
import { createFrame } from "@/tool/computer/frame"
import { LocalOCRParser } from "@/tool/computer/ocr"

const frame = createFrame({
  id: "frame-1", capturedAt: 123,
  screen: { x: -1920, y: 0, width: 1920, height: 1080 },
  rawImageSize: { width: 1920, height: 1080 },
  displayImageSize: { width: 1280, height: 720 },
  monitors: [], foregroundWindow: { id: "42", title: "Editor" },
})

describe("local visual parser", () => {
  test("reports unavailable promptly when model weight is absent", async () => {
    const parser = new LocalVisualParser({ modelPath: path.join(process.cwd(), "missing-model.pt") })
    expect(await parser.health()).toEqual({ ready: false, reason: "model weight is not configured" })
    await expect(parser.parse({ id: "a", png: Buffer.from([1]), width: 8, height: 8 })).rejects.toBeInstanceOf(VisionUnavailableError)
  })

  test("rejects invalid model boxes at the process boundary", () => {
    const result = normalizeVisualBoxes({ width: 100, height: 80 }, [
      { x: 1, y: 2, width: 12, height: 8, confidence: 0.8 },
      { x: 90, y: 2, width: 12, height: 8, confidence: 0.8 },
      { x: -1, y: 2, width: 12, height: 8, confidence: 0.8 },
      { x: 1, y: 2, width: 12, height: 8, confidence: Number.NaN },
    ])
    expect(result).toEqual([{ x: 1, y: 2, width: 12, height: 8, confidence: 0.8, source: "detector" }])
  })

  test("keeps a worker warm and restarts after a crash", async () => {
    await using tmp = await tmpdir()
    const script = path.join(tmp.path, "fake-worker.py")
    const weight = path.join(tmp.path, "fake-model.pt")
    await writeFile(weight, "fake")
    await writeFile(script, [
      "import json, sys",
      "print(json.dumps({'ready': True, 'device': 'fake', 'loadMs': 1}), flush=True)",
      "for line in sys.stdin:",
      "    request = json.loads(line)",
      "    if request['id'].startswith('crash'): sys.exit(2)",
      "    print(json.dumps({'id': request['id'], 'boxes': [{'x': 3, 'y': 4, 'width': 10, 'height': 11, 'confidence': 0.9}], 'inferMs': 1}), flush=True)",
    ].join("\n"))
    const parser = new LocalVisualParser({ modelPath: weight, workerScriptPath: script, timeoutMs: 1000 })
    try {
      expect(await parser.health()).toEqual({ ready: true })
      const frame = { id: "ok", png: Buffer.from([1, 2, 3]), width: 100, height: 80 }
      expect((await parser.parse(frame)).boxes).toEqual([{ x: 3, y: 4, width: 10, height: 11, confidence: 0.9, source: "detector" }])
      expect((await parser.parse(frame)).frameID).toBe("ok")
      await expect(parser.parse({ ...frame, id: "crash" })).rejects.toThrow()
      expect((await parser.parse(frame)).boxes).toHaveLength(1)
    } finally { await parser.close() }
  })
})

describe("optional OCR parser", () => {
  test("keeps text boxes local and validates worker output", async () => {
    await using tmp = await tmpdir()
    const script = path.join(tmp.path, "fake-ocr.py")
    await writeFile(script, [
      "import json, sys",
      "print(json.dumps({'ready': True}), flush=True)",
      "for line in sys.stdin:",
      "    request = json.loads(line)",
      "    print(json.dumps({'id': request['id'], 'tokens': [",
      "      {'text':'保存','box':{'x':10,'y':12,'width':35,'height':20},'confidence':0.9},",
      "      {'text':'outside','box':{'x':999,'y':12,'width':35,'height':20},'confidence':0.9}",
      "    ], 'inferMs': 1}), flush=True)",
    ].join("\n"))
    const parser = new LocalOCRParser({ workerScriptPath: script, timeoutMs: 1000 })
    try {
      expect(await parser.health()).toEqual({ ready: true })
      const tokens = await parser.parse({ id: "a", png: Buffer.from([1]), width: 100, height: 80 })
      expect(tokens).toEqual([{ text: "保存", box: { x: 10, y: 12, width: 35, height: 20 }, confidence: 0.9 }])
    } finally { await parser.close() }
  })
})

describe("visual target fusion and closed action candidates", () => {
  test("tiles large raw screenshots and deduplicates overlap detections", async () => {
    const regions = imageTiles(2560, 1600)
    expect(regions).toHaveLength(6)
    expect(regions.some((region) => region.x === 1280 && region.y === 320)).toBe(true)
    const visited: Array<{ x: number; y: number }> = []
    const parser: VisualParser = {
      health: async () => ({ ready: true }),
      close: async () => undefined,
      parse: async (visualFrame, region) => {
        visited.push({ x: region?.x ?? 0, y: region?.y ?? 0 })
        return { frameID: visualFrame.id, boxes: [{ x: 1200, y: 350, width: 40, height: 30, confidence: 0.8, source: "detector" }], inferMs: 1, totalMs: 1 }
      },
    }
    const result = await parseTiled(parser, { id: "large", png: Buffer.from([1]), width: 2560, height: 1600 })
    expect(visited).toHaveLength(6)
    expect(result.boxes).toHaveLength(1)
  })

  test("joins a detected button with its accessibility and OCR label", () => {
    const result = fuseTargets({
      frame,
      accessibilitySource: "uia",
      elements: [{ index: 1, name: "保存", role: "Button", automationId: "save", x: -1820, y: 60, width: 100, height: 40, enabled: true, focused: false, depth: 1 }],
      detected: [{ x: 102, y: 62, width: 96, height: 38, confidence: 0.82, source: "detector" }],
      ocr: [{ text: "保存", box: { x: 121, y: 70, width: 42, height: 20 }, confidence: 0.94 }],
    })
    expect(result.targets).toHaveLength(1)
    expect(result.targets[0]).toMatchObject({ kind: "button", label: "保存", sources: ["uia", "detector", "ocr"], enabled: true, frameID: "frame-1" })
    expect(result.targets[0]?.box.x).toBeGreaterThanOrEqual(100)
  })

  test("does not merge duplicate labels, nested controls, or distant OCR", () => {
    const result = fuseTargets({
      frame, accessibilitySource: "uia",
      elements: [
        { index: 1, name: "保存", role: "Button", automationId: "left", x: -1810, y: 50, width: 90, height: 35, enabled: true, focused: false, depth: 1 },
        { index: 2, name: "保存", role: "Button", automationId: "right", x: -1510, y: 50, width: 90, height: 35, enabled: true, focused: false, depth: 1 },
        { index: 3, name: "工具栏", role: "Pane", automationId: "bar", x: -1840, y: 30, width: 500, height: 100, enabled: true, focused: false, depth: 0 },
      ],
      detected: [],
      ocr: [{ text: "删除", box: { x: 900, y: 600, width: 40, height: 20 }, confidence: 0.9 }],
    })
    expect(result.targets.filter((target) => target.label === "保存")).toHaveLength(2)
    expect(result.targets.find((target) => target.label === "删除")?.kind).toBe("unknown")
  })

  test("places clicks in a safe interior and excludes disabled targets", () => {
    const targets = fuseTargets({
      frame, accessibilitySource: "uia",
      elements: [
        { index: 1, name: "保存", role: "Button", automationId: "save", x: -1820, y: 60, width: 100, height: 40, enabled: true, focused: false, depth: 1 },
        { index: 2, name: "删除", role: "Button", automationId: "delete", x: -1700, y: 60, width: 100, height: 40, enabled: false, focused: false, depth: 1 },
      ], detected: [], ocr: [],
    }).targets
    const candidates = buildCandidates({ frame, intent: "点击保存", targets, allowedActions: ["click"] })
    expect(candidates.items).toHaveLength(1)
    expect(candidates.items[0]).toMatchObject({ action: "click", point: { x: 150, y: 80 }, frameID: "frame-1" })
  })

  test("caps Jev options without silently treating excluded targets as absent", () => {
    const detected = Array.from({ length: 300 }, (_, index) => ({
      x: (index % 20) * 88, y: Math.floor(index / 20) * 54, width: 60, height: 34,
      confidence: 0.8, source: "detector" as const,
    }))
    const result = fuseTargets({ frame, accessibilitySource: "uia", elements: [], detected, ocr: [] })
    const candidates = buildCandidates({ frame, intent: "点击图标", targets: result.targets, allowedActions: ["click"], limit: 64 })
    expect(result.targets.length).toBeGreaterThan(255)
    expect(candidates.items.length).toBe(64)
    expect(candidates.truncated).toBe(true)
    expect(new Set(candidates.items.map((item) => item.id)).size).toBe(64)
    const upperRight = buildCandidates({ frame, intent: "点击右上角图标", targets: result.targets, allowedActions: ["click"], limit: 64 })
    expect(upperRight.items[0]?.point?.x).toBeGreaterThan(960)
    expect(upperRight.items[0]?.point?.y).toBeLessThan(540)
  })
})
