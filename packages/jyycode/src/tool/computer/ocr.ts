import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import workerAsset from "./ocr-worker.py" with { type: "file" }
import type { OCRToken } from "./fuse"
import type { Rect } from "./frame"
import type { VisualFrame } from "./vision"
import { startJsonLineWorker, type JsonLineWorker } from "./json-line-worker"

export class LocalOCRParser {
  private worker?: JsonLineWorker
  private starting?: Promise<JsonLineWorker>

  constructor(private readonly options: { python?: string; timeoutMs?: number; workerScriptPath?: string } = {}) {}
  isReady() { return !!this.worker && !this.worker.isClosed() }

  async health() {
    try { await this.ensureWorker(); return { ready: true } }
    catch (error) { return { ready: false, reason: error instanceof Error ? error.message : String(error) } }
  }

  private ensureWorker(): Promise<JsonLineWorker> {
    if (this.isReady()) return Promise.resolve(this.worker!)
    if (this.starting) return this.starting
    this.starting = startJsonLineWorker({
      asset: this.options.workerScriptPath ?? workerAsset,
      command: this.options.python ?? process.env.JYYCODE_COMPUTER_VISION_PYTHON ?? "python",
      startupTimeoutMs: 30_000,
    }).then((worker) => (this.worker = worker)).finally(() => { this.starting = undefined })
    return this.starting
  }

  async parse(frame: VisualFrame, signal?: AbortSignal, region?: Rect): Promise<OCRToken[]> {
    if (signal?.aborted) throw new Error("OCR cancelled")
    if (!frame.id || frame.png.length === 0 || frame.width < 1 || frame.height < 1) throw new Error("Invalid OCR frame")
    const worker = await this.ensureWorker()
    const dir = await mkdtemp(path.join(tmpdir(), "jyycode-ocr-frame-"))
    try {
      const imagePath = path.join(dir, "raw.png")
      await writeFile(imagePath, frame.png)
      const reply = await worker.request({ id: frame.id, imagePath, region }, signal, this.options.timeoutMs ?? 5_000)
      if (reply.id !== frame.id || !Array.isArray(reply.tokens)) throw new Error("OCR returned invalid tokens")
      return (reply.tokens as OCRToken[]).filter((token) => token && typeof token.text === "string" &&
        Number.isSafeInteger(token.box?.x) && Number.isSafeInteger(token.box?.y) &&
        Number.isSafeInteger(token.box?.width) && Number.isSafeInteger(token.box?.height) &&
        token.box.x >= 0 && token.box.y >= 0 && token.box.width >= 2 && token.box.height >= 2 &&
        token.box.x + token.box.width <= frame.width && token.box.y + token.box.height <= frame.height &&
        Number.isFinite(token.confidence) && token.confidence >= 0 && token.confidence <= 1)
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

export * as ComputerOCR from "./ocr"
