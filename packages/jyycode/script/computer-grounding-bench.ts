/** Single-action computer timing probe. Dry-run never invokes the OS helper. */
import { appendFile } from "node:fs/promises"
import { runNative, toDesktopAction, type Observation } from "../src/tool/computer/native"
import { stopWindows } from "../src/tool/computer/windows-worker"
import { LocalVisualParser } from "../src/tool/computer/vision"
import { LocalOCRParser } from "../src/tool/computer/ocr"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const live = args.includes("--live")
const outputPath = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length)
const modelPath = args.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? process.env.JYYCODE_COMPUTER_VISION_MODEL
if (dryRun === live) throw new Error("Pass exactly one of --dry-run or --live")

async function record(stage: string, milliseconds: number, extra: Record<string, unknown> = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), mode: dryRun ? "dry-run" : "live", stage, milliseconds, ...extra }) + "\n"
  if (outputPath) await appendFile(outputPath, line)
  else process.stdout.write(line)
}

if (dryRun) {
  const fixture: Observation = {
    screen: { x: -1920, y: 0, width: 3840, height: 1080 },
    image: { width: 1280, height: 360 },
    cursor: { x: 0, y: 0 }, window: "Synthetic app", windowID: "fixture",
    elements: [],
  }
  const started = performance.now()
  const mapped = toDesktopAction({ action: "click", x: 640, y: 180 }, fixture)
  if (mapped.action !== "click") throw new Error("Unexpected mapped action")
  await record("coordinate_map", performance.now() - started, { action: mapped.action, x: mapped.x, y: mapped.y })
  await record("os_input", 0, { skipped: true })
} else {
  const parser = modelPath ? new LocalVisualParser({ modelPath }) : undefined
  const ocr = modelPath ? new LocalOCRParser() : undefined
  try {
    let started = performance.now()
    const fast = await runNative({ action: "observe", includeElements: false, captureRaw: true })
    await record("capture_without_elements", performance.now() - started, {
      imageWidth: fast.observation.image.width, imageHeight: fast.observation.image.height,
      rawWidth: fast.observation.rawImage?.width, rawHeight: fast.observation.rawImage?.height,
      pngBytes: fast.png.length, rawBytes: fast.rawPng?.length,
    })
    started = performance.now()
    const withElements = await runNative({ action: "observe", includeElements: true, captureRaw: true })
    await record("capture_with_elements", performance.now() - started, { elements: withElements.observation.elements.length })
    const raw = withElements.rawPng
    if (raw && parser && withElements.observation.rawImage) {
      const frame = { id: withElements.observation.frameID ?? "bench", png: raw,
        width: withElements.observation.rawImage.width, height: withElements.observation.rawImage.height }
      started = performance.now()
      const health = await parser.health()
      await record("detector_startup", performance.now() - started, { ready: health.ready, reason: health.reason })
      if (health.ready) {
        for (let run = 0; run < 3; run++) {
          const result = await parser.parse(frame)
          await record("detector", result.totalMs, { run, inferMs: result.inferMs, boxes: result.boxes.length })
        }
      }
      if (ocr) {
        started = performance.now()
        const status = await ocr.health()
        await record("ocr_startup", performance.now() - started, { ready: status.ready, reason: status.reason })
        if (status.ready) {
          for (let run = 0; run < 3; run++) {
            started = performance.now()
            const tokens = await ocr.parse(frame)
            await record("ocr", performance.now() - started, { run, tokens: tokens.length })
          }
        }
      }
    }
    process.stderr.write("Live mode only observes; it never moves the mouse or types.\n")
  } finally {
    await parser?.close()
    await ocr?.close()
    if (process.platform === "win32") await stopWindows()
  }
}
