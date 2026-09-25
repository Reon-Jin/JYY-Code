import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import workerAsset from "./vision-worker.py" with { type: "file" }
import type { Rect } from "./frame"
import { startJsonLineWorker, type JsonLineWorker } from "./json-line-worker"

export type VisualFrame = { id: string; png: Buffer; width: number; height: number }
export type VisualBox = { x: number; y: number; width: number; height: number; confidence: number; source: "detector" }
export type VisualParse = { frameID: string; boxes: VisualBox[]; inferMs: number; totalMs: number }
export interface VisualParser {
  health(): Promise<{ ready: boolean; reason?: string }>
  parse(frame: VisualFrame, region?: Rect, signal?: AbortSignal): Promise<VisualParse>
  close(): Promise<void>
}

export class VisionUnavailableError extends Error {
  readonly code = "vision_unavailable"
}

export function imageTiles(width: number, height: number, tileSize = 1280, overlap = 128): Rect[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
    !Number.isSafeInteger(tileSize) || tileSize < 1 || !Number.isSafeInteger(overlap) || overlap < 0 || overlap >= tileSize) {
    throw new Error("Invalid image tile geometry")
  }
  const positions = (length: number) => {
    if (length <= tileSize) return [0]
    const result = [0]
    while (result[result.length - 1]! + tileSize < length) {
      const next = Math.min(length - tileSize, result[result.length - 1]! + tileSize - overlap)
      if (next === result[result.length - 1]) break
      result.push(next)
    }
    return result
  }
  return positions(height).flatMap((y) => positions(width).map((x) => ({
    x, y, width: Math.min(tileSize, width - x), height: Math.min(tileSize, height - y),
  })))
}

function boxIoU(a: VisualBox, b: VisualBox) {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const shared = x * y
  return shared / (a.width * a.height + b.width * b.height - shared)
}

export async function parseTiled(parser: VisualParser, frame: VisualFrame, signal?: AbortSignal): Promise<VisualParse> {
  const started = performance.now()
  const tiles = imageTiles(frame.width, frame.height)
  if (tiles.length === 1) return parser.parse(frame, undefined, signal)
  const boxes: VisualBox[] = []
  let inferMs = 0
  for (const tile of tiles) {
    const result = await parser.parse(frame, tile, signal)
    inferMs += result.inferMs
    for (const box of result.boxes) {
      const existing = boxes.findIndex((item) => boxIoU(item, box) > 0.6)
      if (existing < 0) boxes.push(box)
      else if (box.confidence > boxes[existing]!.confidence) boxes[existing] = box
    }
  }
  return { frameID: frame.id, boxes, inferMs, totalMs: performance.now() - started }
}

export function normalizeVisualBoxes(frame: Pick<VisualFrame, "width" | "height">,
  input: Array<{ x: number; y: number; width: number; height: number; confidence: number }>): VisualBox[] {
  return input.filter((box) =>
    Number.isSafeInteger(box.x) && Number.isSafeInteger(box.y) &&
    Number.isSafeInteger(box.width) && Number.isSafeInteger(box.height) &&
    box.width >= 2 && box.height >= 2 && box.x >= 0 && box.y >= 0 &&
    box.x + box.width <= frame.width && box.y + box.height <= frame.height &&
    Number.isFinite(box.confidence) && box.confidence >= 0 && box.confidence <= 1,
  ).map((box) => ({ ...box, source: "detector" as const }))
}

export class LocalVisualParser implements VisualParser {
  private worker?: JsonLineWorker
  private starting?: Promise<JsonLineWorker>

  constructor(private readonly options: { modelPath?: string; python?: string; device?: "cpu" | "cuda"; timeoutMs?: number; workerScriptPath?: string } = {}) {}
  isReady() { return !!this.worker && !this.worker.isClosed() }

  private modelPath() { return this.options.modelPath ?? process.env.JYYCODE_COMPUTER_VISION_MODEL }

  async health() {
    if (!this.modelPath() || !existsSync(this.modelPath()!)) return { ready: false, reason: "model weight is not configured" }
    try { await this.ensureWorker(); return { ready: true } }
    catch (error) { return { ready: false, reason: error instanceof Error ? error.message : String(error) } }
  }

  private ensureWorker(): Promise<JsonLineWorker> {
    if (this.isReady()) return Promise.resolve(this.worker!)
    if (this.starting) return this.starting
    const model = this.modelPath()
    if (!model || !existsSync(model)) return Promise.reject(new VisionUnavailableError("Local visual detector weight is unavailable"))
    this.starting = startJsonLineWorker({
      asset: this.options.workerScriptPath ?? workerAsset,
      command: this.options.python ?? process.env.JYYCODE_COMPUTER_VISION_PYTHON ?? "python",
      args: ["--model", model, ...(this.options.device ? ["--device", this.options.device] : [])],
    }).then((worker) => (this.worker = worker)).finally(() => { this.starting = undefined })
    return this.starting
  }

  async parse(frame: VisualFrame, region?: Rect, signal?: AbortSignal): Promise<VisualParse> {
    if (signal?.aborted) throw new VisionUnavailableError("Visual detection was cancelled")
    if (!frame.id || frame.png.length === 0 || frame.width < 1 || frame.height < 1) throw new Error("Invalid visual frame")
    const started = performance.now()
    const worker = await this.ensureWorker()
    const dir = await mkdtemp(path.join(tmpdir(), "jyycode-vision-frame-"))
    try {
      const imagePath = path.join(dir, "raw.png")
      await writeFile(imagePath, frame.png)
      const reply = await worker.request({ id: frame.id, imagePath, region }, signal, this.options.timeoutMs ?? 10_000)
      if (reply.id !== frame.id || !Array.isArray(reply.boxes) || !Number.isFinite(reply.inferMs)) {
        throw new Error("Visual detector returned an invalid response")
      }
      const boxes = normalizeVisualBoxes(frame, reply.boxes as Array<{ x: number; y: number; width: number; height: number; confidence: number }>)
      return { frameID: frame.id, boxes, inferMs: reply.inferMs as number, totalMs: performance.now() - started }
    } catch (error) {
      if (worker.isClosed()) this.worker = undefined
      throw error
    } finally { await rm(dir, { recursive: true, force: true }) }
  }

  async close() {
    if (this.worker) await this.worker.close()
    this.worker = undefined
  }
}

export * as ComputerVision from "./vision"
