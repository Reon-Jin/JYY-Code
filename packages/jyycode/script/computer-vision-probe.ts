/** Local detector smoke/latency probe. Uses only synthetic fixtures by default. */
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { LocalVisualParser, parseTiled } from "../src/tool/computer/vision"

const modelPath = process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ?? process.env.JYYCODE_COMPUTER_VISION_MODEL
const imagePath = process.argv.find((arg) => arg.startsWith("--image="))?.slice(8) ?? path.join(import.meta.dir, "../test/tool/fixtures/computer-synthetic-96.png")
const datasetPath = process.argv.find((arg) => arg.startsWith("--dataset="))?.slice(10)
const tiled = process.argv.includes("--tiled")
const count = Number(process.argv.find((arg) => arg.startsWith("--runs="))?.slice(7) ?? "3")
if (!modelPath) throw new Error("Pass --model=<icon_detect_v3/model.pt> or set JYYCODE_COMPUTER_VISION_MODEL")
if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error("--runs must be 1 to 20")

const hash = createHash("sha256")
for await (const chunk of createReadStream(modelPath)) hash.update(chunk)
const modelSha256 = hash.digest("hex")
if (datasetPath) {
  type Annotation = { id: string; img_filename: string; img_size: [number, number]; bbox: [number, number, number, number]; ui_type: string }
  const annotations = JSON.parse(await readFile(datasetPath, "utf8")) as Annotation[]
  const grouped = Map.groupBy(annotations, (item) => item.img_filename)
  const parser = new LocalVisualParser({ modelPath })
  const started = performance.now()
  try {
    const health = await parser.health()
    if (!health.ready) throw new Error(health.reason ?? "Visual parser unavailable")
    const loadMs = performance.now() - started
    const outcomes: Array<{ id: string; uiType: string; matched: boolean; latencyMs: number }> = []
    const latencies: number[] = []
    for (const [filename, labels] of grouped) {
      const first = labels[0]!
      const png = await readFile(path.join(path.dirname(datasetPath), filename))
      const frame = { id: filename, png, width: first.img_size[0], height: first.img_size[1] }
      const result = tiled ? await parseTiled(parser, frame) : await parser.parse(frame)
      latencies.push(Math.round(result.totalMs))
      for (const item of labels) {
        const [left, top, right, bottom] = item.bbox
        const matched = result.boxes.some((box) => {
          const x = box.x + box.width / 2
          const y = box.y + box.height / 2
          return x >= left && x < right && y >= top && y < bottom
        })
        outcomes.push({ id: item.id, uiType: item.ui_type, matched, latencyMs: Math.round(result.totalMs) })
      }
    }
    const byType = Object.fromEntries([...new Set(outcomes.map((item) => item.uiType))].map((uiType) => {
      const group = outcomes.filter((item) => item.uiType === uiType)
      return [uiType, { matched: group.filter((item) => item.matched).length, total: group.length }]
    }))
    latencies.sort((a, b) => a - b)
    const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)]
    process.stdout.write(JSON.stringify({
      modelSha256, dataset: path.basename(datasetPath), tiled, imageCount: grouped.size,
      targets: outcomes.length, matched: outcomes.filter((item) => item.matched).length,
      byType, loadMs: Math.round(loadMs), detectorP50Ms: percentile(0.5), detectorP95Ms: percentile(0.95), outcomes,
      note: "Small visual-only sample; target matched when a detector-box center lies inside its annotated click box. No Jev or OS input is measured.",
    }) + "\n")
  } finally { await parser.close() }
  process.exit(0)
}
const png = await readFile(imagePath)
const fixture = JSON.parse(await readFile(path.join(import.meta.dir, "../test/tool/fixtures/computer-synthetic.json"), "utf8")) as Array<{
  name: string; screen: { width: number; height: number }; targets: Record<string, [number, number, number, number]>
}>
const known = fixture.find((item) => path.basename(imagePath) === item.name)
const parser = new LocalVisualParser({ modelPath })
try {
  const started = performance.now()
  const health = await parser.health()
  if (!health.ready) throw new Error(health.reason ?? "Visual parser unavailable")
  const loadMs = performance.now() - started
  const runs = []
  for (let i = 0; i < count; i++) {
    const result = await parser.parse({ id: `probe-${i}`, png, width: known?.screen.width ?? 1280, height: known?.screen.height ?? 720 })
    const matchedTargets = known ? Object.values(known.targets).filter(([left, top, right, bottom]) =>
      result.boxes.some((box) => {
        const centerX = box.x + box.width / 2
        const centerY = box.y + box.height / 2
        return centerX >= left && centerX < right && centerY >= top && centerY < bottom
      })).length : undefined
    runs.push({ totalMs: Math.round(result.totalMs), inferMs: result.inferMs, boxes: result.boxes.length, matchedTargets })
  }
  process.stdout.write(JSON.stringify({
    modelSha256,
    modelLicense: "MIT (icon_detect_v3; verify upstream LICENSE before redistribution)",
    image: path.basename(imagePath),
    synthetic: !!known,
    labeledTargets: known ? Object.keys(known.targets).length : undefined,
    loadMs: Math.round(loadMs),
    runs,
    note: "Synthetic fixture is only a smoke test; it cannot establish real desktop recall or misclick rate",
  }) + "\n")
} finally { await parser.close() }
