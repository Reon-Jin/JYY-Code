import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { LocalVisualParser, normalizeVisualBoxes, VisionUnavailableError } from "@/tool/computer/vision"

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
      "    if request['id'].startswith('crash:'): sys.exit(2)",
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
