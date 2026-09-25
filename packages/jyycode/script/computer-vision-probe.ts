/** Local detector smoke/latency probe. Uses only synthetic fixtures by default. */
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { LocalVisualParser } from "../src/tool/computer/vision"

const modelPath = process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ?? process.env.JYYCODE_COMPUTER_VISION_MODEL
const imagePath = process.argv.find((arg) => arg.startsWith("--image="))?.slice(8) ?? path.join(import.meta.dir, "../test/tool/fixtures/computer-synthetic-96.png")
const count = Number(process.argv.find((arg) => arg.startsWith("--runs="))?.slice(7) ?? "3")
if (!modelPath) throw new Error("Pass --model=<icon_detect_v3/model.pt> or set JYYCODE_COMPUTER_VISION_MODEL")
if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error("--runs must be 1 to 20")

const hash = createHash("sha256")
for await (const chunk of createReadStream(modelPath)) hash.update(chunk)
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
    runs.push({ totalMs: Math.round(result.totalMs), inferMs: result.inferMs, boxes: result.boxes.length })
  }
  process.stdout.write(JSON.stringify({
    modelSha256: hash.digest("hex"),
    modelLicense: "MIT (icon_detect_v3; verify upstream LICENSE before redistribution)",
    image: path.basename(imagePath),
    synthetic: true,
    loadMs: Math.round(loadMs),
    runs,
    note: "Synthetic fixture is only a smoke test; it cannot establish real desktop recall or misclick rate",
  }) + "\n")
} finally { await parser.close() }
