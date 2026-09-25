/** Single-action computer timing probe. Dry-run never invokes the OS helper. */
import { appendFile } from "node:fs/promises"
import { runNative, toDesktopAction, type Observation } from "../src/tool/computer/native"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const live = args.includes("--live")
const outputPath = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length)
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
  const started = performance.now()
  const observation = await runNative({ action: "observe", includeElements: false })
  await record("capture_without_elements", performance.now() - started, {
    imageWidth: observation.observation.image.width,
    imageHeight: observation.observation.image.height,
    pngBytes: observation.png.length,
  })
  process.stderr.write("Live mode only observes; it never moves the mouse or types.\n")
}
