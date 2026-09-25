import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface, type Interface } from "node:readline"
import workerAsset from "./vision-worker.py" with { type: "file" }
import type { Rect } from "./frame"

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

type WorkerReply =
  | { ready: boolean; error?: string; device?: string; loadMs?: number }
  | { id: string; boxes?: Array<{ x: number; y: number; width: number; height: number; confidence: number }>; inferMs?: number; error?: string }

type Pending = { id: string; resolve: (value: WorkerReply) => void; reject: (error: Error) => void }
type Worker = { process: ChildProcessWithoutNullStreams; lines: Interface; dir: string }

export class LocalVisualParser implements VisualParser {
  private worker?: Worker
  private starting?: Promise<Worker>
  private pending?: Pending
  private tail: Promise<unknown> = Promise.resolve()
  private sequence = 0

  constructor(private readonly options: { modelPath?: string; python?: string; device?: "cpu" | "cuda"; timeoutMs?: number; workerScriptPath?: string } = {}) {}

  private modelPath() {
    return this.options.modelPath ?? process.env.JYYCODE_COMPUTER_VISION_MODEL
  }

  async health() {
    if (!this.modelPath() || !existsSync(this.modelPath()!)) return { ready: false, reason: "model weight is not configured" }
    try { await this.ensureWorker(); return { ready: true } }
    catch (error) { return { ready: false, reason: error instanceof Error ? error.message : String(error) } }
  }

  private ensureWorker(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker)
    if (this.starting) return this.starting
    this.starting = this.startWorker().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async startWorker(): Promise<Worker> {
    const model = this.modelPath()
    if (!model || !existsSync(model)) throw new VisionUnavailableError("Local visual detector weight is unavailable")
    const dir = await mkdtemp(path.join(tmpdir(), "jyycode-vision-"))
    const script = path.join(dir, "worker.py")
    await writeFile(script, Buffer.from(await Bun.file(this.options.workerScriptPath ?? workerAsset).arrayBuffer()))
    const args = ["-u", script, "--model", model]
    if (this.options.device) args.push("--device", this.options.device)
    const child = spawn(this.options.python ?? process.env.JYYCODE_COMPUTER_VISION_PYTHON ?? "python", args, {
      stdio: "pipe", windowsHide: true, shell: false,
    })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    let stderr = ""
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-4096) })
    const worker: Worker = { process: child, lines, dir }
    let readyResolve!: (value: Worker) => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<Worker>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    let started = false
    lines.on("line", (line) => {
      let reply: WorkerReply
      try { reply = JSON.parse(line) as WorkerReply }
      catch { this.invalidate(worker, new Error("Visual detector returned invalid JSON")); return }
      if (!started && "ready" in reply) {
        started = true
        if (reply.ready) { this.worker = worker; readyResolve(worker) }
        else readyReject(new VisionUnavailableError(reply.error ?? "Visual detector did not start"))
        return
      }
      if ("id" in reply && this.pending?.id === reply.id) {
        const pending = this.pending
        this.pending = undefined
        if (reply.error) pending.reject(new Error(reply.error))
        else pending.resolve(reply)
      }
    })
    child.on("error", (error) => {
      if (!started) readyReject(new VisionUnavailableError(`Visual detector could not start: ${error.message}`))
      this.invalidate(worker, error)
    })
    child.on("exit", (code) => {
      const error = new VisionUnavailableError(stderr.trim() || `Visual detector exited with ${code}`)
      if (!started) readyReject(error)
      this.invalidate(worker, error)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        ready,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new VisionUnavailableError("Visual detector startup timed out")), 45_000) }),
      ])
    } catch (error) {
      child.kill()
      lines.close()
      await rm(dir, { recursive: true, force: true })
      throw error
    } finally { clearTimeout(timer) }
  }

  private invalidate(worker: Worker, error: Error) {
    if (this.worker !== worker) return
    this.worker = undefined
    this.pending?.reject(error)
    this.pending = undefined
    worker.lines.close()
    worker.process.kill()
    void rm(worker.dir, { recursive: true, force: true })
  }

  parse(frame: VisualFrame, region?: Rect, signal?: AbortSignal): Promise<VisualParse> {
    const run = () => this.parseOnce(frame, region, signal)
    const current = this.tail.then(run, run)
    this.tail = current.catch(() => undefined)
    return current
  }

  private async parseOnce(frame: VisualFrame, region?: Rect, signal?: AbortSignal): Promise<VisualParse> {
    if (signal?.aborted) throw new VisionUnavailableError("Visual detection was cancelled")
    if (!frame.id || frame.png.length === 0 || frame.width < 1 || frame.height < 1) throw new Error("Invalid visual frame")
    const started = performance.now()
    const worker = await this.ensureWorker()
    const dir = await mkdtemp(path.join(tmpdir(), "jyycode-vision-frame-"))
    const imagePath = path.join(dir, "raw.png")
    try {
      await writeFile(imagePath, frame.png)
      const id = `${frame.id}:${++this.sequence}`
      const reply = await new Promise<WorkerReply>((resolve, reject) => {
        const abort = () => this.invalidate(worker, new VisionUnavailableError("Visual detection was cancelled"))
        const timeout = setTimeout(() => this.invalidate(worker, new VisionUnavailableError("Visual detection timed out")), this.options.timeoutMs ?? 10_000)
        const settle = (work: () => void) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); work() }
        this.pending = {
          id,
          resolve: (value) => settle(() => resolve(value)),
          reject: (error) => settle(() => reject(error)),
        }
        signal?.addEventListener("abort", abort, { once: true })
        try { worker.process.stdin.write(JSON.stringify({ id, imagePath, region }) + "\n") }
        catch (error) { this.invalidate(worker, error instanceof Error ? error : new Error(String(error))) }
      })
      if (!("id" in reply) || !Array.isArray(reply.boxes) || !Number.isFinite(reply.inferMs)) {
        throw new Error("Visual detector returned an invalid response")
      }
      const boxes = normalizeVisualBoxes(frame, reply.boxes)
      return { frameID: frame.id, boxes, inferMs: reply.inferMs!, totalMs: performance.now() - started }
    } finally { await rm(dir, { recursive: true, force: true }) }
  }

  async close() {
    const worker = this.worker
    if (!worker) return
    this.invalidate(worker, new VisionUnavailableError("Visual detector stopped"))
  }
}

export function normalizeVisualBoxes(frame: Pick<VisualFrame, "width" | "height">, input: Array<{ x: number; y: number; width: number; height: number; confidence: number }>): VisualBox[] {
  return input.filter((box) =>
        Number.isSafeInteger(box.x) && Number.isSafeInteger(box.y) &&
        Number.isSafeInteger(box.width) && Number.isSafeInteger(box.height) &&
        box.width >= 2 && box.height >= 2 && box.x >= 0 && box.y >= 0 &&
        box.x + box.width <= frame.width && box.y + box.height <= frame.height &&
        Number.isFinite(box.confidence) && box.confidence >= 0 && box.confidence <= 1,
  ).map((box) => ({ ...box, source: "detector" as const }))
}

export * as ComputerVision from "./vision"
