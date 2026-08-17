import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export const DEFAULT_LOG_FILE_BYTES = 10 * 1024 * 1024
export const DEFAULT_LOG_TOTAL_BYTES = 50 * 1024 * 1024
export const DEFAULT_LOG_FILE_COUNT = 10
export const DEFAULT_LOG_RECORD_BYTES = 16 * 1024
export const DEFAULT_LOG_QUEUE_CAPACITY = 256

export interface LogSinkOptions {
  readonly file: string
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
  readonly maxFiles?: number
  readonly maxRecordBytes?: number
  readonly queueCapacity?: number
}

export interface LogSinkStats {
  readonly queued: number
  readonly dropped: number
  readonly writtenBytes: number
  readonly rotations: number
}

const REDACTION_PATTERNS = [
  /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
  /((?:x-)?api[-_ ]?key\s*[:=]\s*)[^\s,;]+/gi,
  /(cookie\s*:\s*)[^\r\n]+/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /([A-Za-z]:[\\/]+Users[\\/])[^\\/\s"']+/gi,
  /(\/Users\/)[^/\s"']+/g,
  /(\/home\/)[^/\s"']+/g,
]

export function redactLogText(value: string) {
  let result = value
  result = result.replace(REDACTION_PATTERNS[0]!, "$1<redacted>")
  result = result.replace(REDACTION_PATTERNS[1]!, "$1<redacted>")
  result = result.replace(REDACTION_PATTERNS[2]!, "$1<redacted>")
  result = result.replace(REDACTION_PATTERNS[3]!, "<redacted>")
  result = result.replace(REDACTION_PATTERNS[4]!, "$1<user>")
  result = result.replace(REDACTION_PATTERNS[5]!, "$1<user>")
  result = result.replace(REDACTION_PATTERNS[6]!, "$1<user>")
  return result
}

export function boundLogText(value: string, maxBytes = DEFAULT_LOG_RECORD_BYTES) {
  return boundedString(redactLogText(value), maxBytes)
}

function boundedString(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const digest = createHash("sha256").update(value).digest("hex")
  const suffix = `…<truncated bytes=${Buffer.byteLength(value)} sha256=${digest}>`
  if (Buffer.byteLength(suffix) >= maxBytes) return suffix.slice(0, maxBytes)
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes - Buffer.byteLength(suffix)) end--
  return `${value.slice(0, end)}${suffix}`
}

/** Serialize only a bounded, shallow view so a huge tool result is never stringified wholesale. */
export function formatLogValue(
  value: unknown,
  maxBytes = DEFAULT_LOG_RECORD_BYTES,
  depth = 0,
  seen = new WeakSet<object>(),
): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === "string") return boundedString(redactLogText(value), maxBytes)
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  if (value instanceof Error) return boundedString(redactLogText(value.message), maxBytes)
  if (depth >= 3 || typeof value !== "object") return "[Object]"
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  const entries = Array.isArray(value)
    ? value.slice(0, 64).map((item, index) => [String(index), item] as const)
    : Object.entries(value).slice(0, 64)
  const parts: string[] = []
  let bytes = 2
  for (const [key, item] of entries) {
    const rendered = formatLogValue(item, Math.max(64, maxBytes - bytes), depth + 1, seen)
    const next = `${JSON.stringify(key)}:${JSON.stringify(rendered)}`
    if (bytes + Buffer.byteLength(next) > maxBytes) {
      parts.push('"<truncated>":true')
      break
    }
    parts.push(next)
    bytes += Buffer.byteLength(next)
  }
  seen.delete(value)
  return boundedString(`{${parts.join(",")}}`, maxBytes)
}

export function formatLogRecord(message: unknown, extra?: Record<string, unknown>) {
  const prefix = Object.entries(extra ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ")
  return boundedString(
    redactLogText([prefix, formatLogValue(message)].filter(Boolean).join(" ")),
    DEFAULT_LOG_RECORD_BYTES,
  )
}

export class BoundedLogSink {
  readonly file: string
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly maxFiles: number
  readonly maxRecordBytes: number
  readonly queueCapacity: number

  private readonly queue: string[] = []
  private draining: Promise<void> | undefined
  private closed = false
  private fileBytes = 0
  private dropped = 0
  private writtenBytes = 0
  private rotations = 0

  constructor(options: LogSinkOptions) {
    this.file = options.file
    this.maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes ?? DEFAULT_LOG_FILE_BYTES))
    this.maxTotalBytes = Math.max(this.maxFileBytes, Math.floor(options.maxTotalBytes ?? DEFAULT_LOG_TOTAL_BYTES))
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_LOG_FILE_COUNT))
    this.maxRecordBytes = Math.max(1, Math.floor(options.maxRecordBytes ?? DEFAULT_LOG_RECORD_BYTES))
    this.queueCapacity = Math.max(1, Math.floor(options.queueCapacity ?? DEFAULT_LOG_QUEUE_CAPACITY))
  }

  write(value: string) {
    if (this.closed) return false
    if (this.queue.length >= this.queueCapacity) {
      this.dropped++
      return false
    }
    this.queue.push(boundedString(redactLogText(value), this.maxRecordBytes) + (value.endsWith("\n") ? "" : "\n"))
    this.draining ??= this.drain().catch((error) => {
      process.stderr.write(`log sink failure: ${String(error)}\n`)
    })
    return true
  }

  stats(): LogSinkStats {
    return {
      queued: this.queue.length,
      dropped: this.dropped,
      writtenBytes: this.writtenBytes,
      rotations: this.rotations,
    }
  }

  async flush(timeoutMs = 2_000) {
    const pending = this.draining
    if (!pending) return
    await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, timeoutMs)))])
  }

  async close() {
    this.closed = true
    await this.flush()
  }

  private async drain() {
    try {
      while (this.queue.length) {
        const record = this.queue.shift()!
        await this.append(record)
      }
    } finally {
      this.draining = undefined
      if (this.queue.length && !this.closed) this.draining = this.drain().catch(() => {})
    }
  }

  private async append(record: string) {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    if (!this.fileBytes) {
      const stat = await fs.stat(this.file).catch(() => undefined)
      this.fileBytes = stat?.size ?? 0
    }
    const existing = await fs.lstat(this.file).catch(() => undefined)
    if (existing?.isSymbolicLink()) throw new Error(`refusing to write log symlink: ${this.file}`)
    const bytes = Buffer.byteLength(record)
    if (this.fileBytes + bytes > this.maxFileBytes) {
      await this.rotate()
    }
    await fs.appendFile(this.file, record, { encoding: "utf8", mode: 0o600 })
    if (process.platform !== "win32") {
      const stat = await fs.lstat(this.file).catch(() => undefined)
      if (stat?.isFile()) await fs.chmod(this.file, 0o600).catch(() => {})
    }
    this.fileBytes += bytes
    this.writtenBytes += bytes
    await this.trimTotal()
  }

  private async rotate() {
    await fs.rm(`${this.file}.${this.maxFiles}`, { force: true }).catch(() => {})
    for (let index = this.maxFiles - 1; index >= 1; index--) {
      await fs.rename(`${this.file}.${index}`, `${this.file}.${index + 1}`).catch(() => {})
    }
    await fs.rename(this.file, `${this.file}.1`).catch(() => {})
    this.fileBytes = 0
    this.rotations++
  }

  private async trimTotal() {
    const names = (await fs.readdir(path.dirname(this.file))).filter(
      (name) => name === path.basename(this.file) || name.startsWith(`${path.basename(this.file)}.`),
    )
    const files = await Promise.all(
      names.map(async (name) => ({
        name,
        stat: await fs.stat(path.join(path.dirname(this.file), name)).catch(() => undefined),
      })),
    )
    let total = files.reduce((sum, item) => sum + (item.stat?.size ?? 0), 0)
    const candidates = files
      .filter((item) => item.name !== path.basename(this.file) && item.stat)
      .sort((a, b) => a.stat!.mtimeMs - b.stat!.mtimeMs || a.name.localeCompare(b.name))
    while ((total > this.maxTotalBytes || names.length > this.maxFiles) && candidates.length) {
      const item = candidates.shift()!
      await fs.rm(path.join(path.dirname(this.file), item.name), { force: true })
      total -= item.stat?.size ?? 0
      names.splice(names.indexOf(item.name), 1)
    }
  }
}

export * as LogSink from "./log-sink"
