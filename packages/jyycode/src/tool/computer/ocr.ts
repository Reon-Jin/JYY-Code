import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface, type Interface } from "node:readline"
import workerAsset from "./ocr-worker.py" with { type: "file" }
import type { OCRToken } from "./fuse"
import type { VisualFrame } from "./vision"
import type { Rect } from "./frame"

type Reply = { ready: boolean; error?: string } | { id: string; tokens?: OCRToken[]; inferMs?: number; error?: string }
type Worker = { process: ChildProcessWithoutNullStreams; lines: Interface; dir: string }

export class LocalOCRParser {
  private worker?: Worker
  private starting?: Promise<Worker>
  private pending?: { id: string; resolve: (reply: Reply) => void; reject: (error: Error) => void }
  private tail: Promise<unknown> = Promise.resolve()
  private sequence = 0

  constructor(private readonly options: { python?: string; timeoutMs?: number; workerScriptPath?: string } = {}) {}
  isReady() { return !!this.worker }

  async health() {
    try { await this.ensure(); return { ready: true } }
    catch (error) { return { ready: false, reason: error instanceof Error ? error.message : String(error) } }
  }

  private ensure(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker)
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async start(): Promise<Worker> {
    const dir = await mkdtemp(path.join(tmpdir(), "jyycode-ocr-"))
    const script = path.join(dir, "worker.py")
    await writeFile(script, Buffer.from(await Bun.file(this.options.workerScriptPath ?? workerAsset).arrayBuffer()))
    const child = spawn(this.options.python ?? process.env.JYYCODE_COMPUTER_VISION_PYTHON ?? "python", ["-u", script],
      { stdio: "pipe", windowsHide: true, shell: false })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    const worker: Worker = { process: child, lines, dir }
    let readyResolve!: (worker: Worker) => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<Worker>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    let started = false
    let stderr = ""
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-2048) })
    lines.on("line", (line) => {
      let reply: Reply
      try { reply = JSON.parse(line) as Reply }
      catch { this.invalidate(worker, new Error("OCR returned invalid JSON")); return }
      if (!started && "ready" in reply) {
        started = true
        if (reply.ready) { this.worker = worker; readyResolve(worker) }
        else readyReject(new Error(reply.error ?? "OCR did not start"))
        return
      }
      if ("id" in reply && this.pending?.id === reply.id) {
        const pending = this.pending
        this.pending = undefined
        if (reply.error) pending.reject(new Error(reply.error))
        else pending.resolve(reply)
      }
    })
    child.on("error", (error) => { if (!started) readyReject(error); this.invalidate(worker, error) })
    child.on("exit", (code) => {
      const error = new Error(stderr.trim() || `OCR exited with ${code}`)
      if (!started) readyReject(error)
      this.invalidate(worker, error)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("OCR startup timed out")), 30_000)
      })])
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

  parse(frame: VisualFrame, signal?: AbortSignal, region?: Rect): Promise<OCRToken[]> {
    const run = () => this.parseOnce(frame, signal, region)
    const current = this.tail.then(run, run)
    this.tail = current.catch(() => undefined)
    return current
  }

  private async parseOnce(frame: VisualFrame, signal?: AbortSignal, region?: Rect): Promise<OCRToken[]> {
    if (signal?.aborted) throw new Error("OCR cancelled")
    const worker = await this.ensure()
    const dir = await mkdtemp(path.join(tmpdir(), "jyycode-ocr-frame-"))
    const imagePath = path.join(dir, "raw.png")
    try {
      await writeFile(imagePath, frame.png)
      const id = `${frame.id}:${++this.sequence}`
      const reply = await new Promise<Reply>((resolve, reject) => {
        const abort = () => this.invalidate(worker, new Error("OCR cancelled"))
        const timeout = setTimeout(() => this.invalidate(worker, new Error("OCR timed out")), this.options.timeoutMs ?? 5_000)
        const settle = (work: () => void) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); work() }
        this.pending = { id, resolve: (value) => settle(() => resolve(value)), reject: (error) => settle(() => reject(error)) }
        signal?.addEventListener("abort", abort, { once: true })
        try { worker.process.stdin.write(JSON.stringify({ id, imagePath, region }) + "\n") }
        catch (error) { this.invalidate(worker, error instanceof Error ? error : new Error(String(error))) }
      })
      if (!("id" in reply) || !Array.isArray(reply.tokens)) throw new Error("OCR returned invalid tokens")
      return reply.tokens.filter((token) => token && typeof token.text === "string" &&
        Number.isSafeInteger(token.box?.x) && Number.isSafeInteger(token.box?.y) &&
        Number.isSafeInteger(token.box?.width) && Number.isSafeInteger(token.box?.height) &&
        token.box.x >= 0 && token.box.y >= 0 && token.box.width >= 2 && token.box.height >= 2 &&
        token.box.x + token.box.width <= frame.width && token.box.y + token.box.height <= frame.height &&
        Number.isFinite(token.confidence) && token.confidence >= 0 && token.confidence <= 1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }

  async close() {
    if (this.worker) this.invalidate(this.worker, new Error("OCR stopped"))
  }
}

export * as ComputerOCR from "./ocr"
