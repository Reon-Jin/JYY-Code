import { createHash, type Hash } from "node:crypto"

export type OutputRetentionStrategy = "head" | "tail" | "head_tail"

export type OutputBlobReference = {
  readonly ref: string
}

export interface OutputBlobWriter {
  readonly write: (source: AsyncIterable<Uint8Array>) => Promise<OutputBlobReference>
}

export interface OutputRetentionOptions {
  readonly maxBytes: number
  readonly strategy?: OutputRetentionStrategy
  readonly blob?: OutputBlobWriter
  readonly spill?: "always" | "on_truncate"
}

export type OutputRetentionResult = {
  readonly preview: string
  readonly bytesSeen: number
  readonly bytesRetained: number
  readonly truncated: boolean
  readonly sha256: string
  readonly blobRef?: string
  readonly blobError?: string
}

export interface OutputRetention {
  readonly append: (chunk: Uint8Array | string) => Promise<void>
  readonly snapshot: () => OutputRetentionResult
  readonly flush: () => Promise<OutputRetentionResult>
  readonly cancel: () => Promise<OutputRetentionResult>
}

const DEFAULT_STRATEGY: OutputRetentionStrategy = "head_tail"
const UTF8 = new TextDecoder("utf-8", { fatal: true })

function nonNegativeBytes(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("maxBytes must be a non-negative integer")
  return value
}

function decodeUtf8(bytes: Uint8Array) {
  for (let end = bytes.byteLength; end >= 0; end--) {
    try {
      return UTF8.decode(bytes.subarray(0, end))
    } catch {
      // A head preview can end in the middle of a multi-byte code point.
    }
  }
  return ""
}

function decodeTailUtf8(bytes: Uint8Array) {
  for (let start = 0; start <= bytes.byteLength; start++) {
    try {
      return UTF8.decode(bytes.subarray(start))
    } catch {
      // A tail preview can start in the middle of a multi-byte code point.
    }
  }
  return ""
}

function concat(chunks: readonly Uint8Array[]) {
  if (chunks.length === 0) return new Uint8Array()
  if (chunks.length === 1) return chunks[0]
  return Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

function appendTail(existing: readonly Uint8Array[], chunk: Uint8Array, maxBytes: number) {
  if (maxBytes <= 0) return []
  if (chunk.byteLength >= maxBytes) return [chunk.slice(chunk.byteLength - maxBytes)]
  const next = concat([...existing, chunk])
  return next.byteLength <= maxBytes ? [next] : [next.slice(next.byteLength - maxBytes)]
}

class ChunkQueue implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = []
  private readonly readers: Array<(result: IteratorResult<Uint8Array>) => void> = []
  private readonly writers: Array<() => void> = []
  private closed = false

  constructor(private readonly capacity = 16) {}

  async push(chunk: Uint8Array) {
    while (!this.closed && this.chunks.length >= this.capacity) {
      await new Promise<void>((resolve) => this.writers.push(resolve))
    }
    if (this.closed) return
    const reader = this.readers.shift()
    if (reader) reader({ done: false, value: chunk })
    else this.chunks.push(chunk)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const resolve of this.writers.splice(0)) resolve()
    for (const resolve of this.readers.splice(0)) resolve({ done: true, value: undefined })
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    const chunk = this.chunks.shift()
    const writer = this.writers.shift()
    if (writer) writer()
    if (chunk) return { done: false, value: chunk }
    if (this.closed) return { done: true, value: undefined }
    return new Promise((resolve) => this.readers.push(resolve))
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

class Retention implements OutputRetention {
  private readonly strategy: OutputRetentionStrategy
  private readonly maxBytes: number
  private readonly headLimit: number
  private readonly tailLimit: number
  private readonly hash: Hash = createHash("sha256")
  private complete: Uint8Array[] | undefined = []
  private head: Uint8Array[] = []
  private tail: Uint8Array[] = []
  private totalBytes = 0
  private closed = false
  private result: OutputRetentionResult | undefined
  private blobRef: string | undefined
  private blobError: string | undefined
  private readonly blobWriter: OutputBlobWriter | undefined
  private queue: ChunkQueue | undefined
  private blobTask: Promise<void> | undefined
  private enqueue: Promise<void> = Promise.resolve()

  constructor(options: OutputRetentionOptions) {
    this.maxBytes = nonNegativeBytes(options.maxBytes)
    this.strategy = options.strategy ?? DEFAULT_STRATEGY
    this.headLimit =
      this.strategy === "head" ? this.maxBytes : this.strategy === "head_tail" ? Math.floor(this.maxBytes / 2) : 0
    this.tailLimit =
      this.strategy === "tail" ? this.maxBytes : this.strategy === "head_tail" ? this.maxBytes - this.headLimit : 0
    this.blobWriter = options.blob

    if (options.blob && options.spill !== "on_truncate") {
      this.startBlob()
    }
  }

  private startBlob() {
    if (this.queue || !this.blobWriter) return
    this.queue = new ChunkQueue()
    this.blobTask = Promise.resolve()
      .then(() => this.blobWriter!.write(this.queue!))
      .then((reference) => {
        this.blobRef = reference.ref
      })
      .catch((error) => {
        this.blobError = error instanceof Error ? error.message : String(error)
        this.queue?.close()
      })
  }

  private enqueueChunk(chunk: Uint8Array) {
    if (!this.queue) return Promise.resolve()
    this.enqueue = this.enqueue.then(() => this.queue?.push(chunk)).then(() => undefined)
    return this.enqueue
  }

  async append(chunk: Uint8Array | string) {
    if (this.closed) throw new Error("output retention is already closed")
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
    this.totalBytes += bytes.byteLength
    this.hash.update(bytes)

    if (this.complete && this.totalBytes <= this.maxBytes) {
      this.complete.push(bytes.slice())
    } else {
      if (this.complete) {
        const previous = this.complete
        this.complete = undefined
        const lazyBlob = Boolean(this.blobWriter && !this.queue)
        if (lazyBlob) this.startBlob()
        if (lazyBlob && this.queue) {
          for (const item of previous) await this.enqueueChunk(item)
        }
        for (const item of previous) this.capture(item)
      }
      this.capture(bytes)
    }

    if (this.queue) await this.enqueueChunk(bytes)
  }

  private capture(bytes: Uint8Array) {
    if (this.headLimit > 0) {
      const retained = this.head.reduce((total, item) => total + item.byteLength, 0)
      const remaining = this.headLimit - retained
      if (remaining > 0) this.head.push(bytes.slice(0, remaining))
    }
    if (this.tailLimit > 0) this.tail = appendTail(this.tail, bytes, this.tailLimit)
  }

  private retainedBytes() {
    if (this.complete) return concat(this.complete)
    if (this.strategy === "head") return concat(this.head)
    if (this.strategy === "tail") return concat(this.tail)
    return concat([...this.head, ...this.tail])
  }

  private makeResult(final = false): OutputRetentionResult {
    if (this.result) return this.result
    const truncated = this.totalBytes > this.maxBytes
    const retained = this.retainedBytes()
    const head = this.complete ? decodeUtf8(retained) : decodeUtf8(concat(this.head))
    const tail = this.complete ? "" : decodeTailUtf8(concat(this.tail))
    const preview = !truncated
      ? head
      : this.strategy === "head"
        ? head
        : this.strategy === "tail"
          ? tail
          : `${head}\n\n${tail}`

    const result: OutputRetentionResult = {
      preview,
      bytesSeen: this.totalBytes,
      bytesRetained: retained.byteLength,
      truncated,
      sha256: final ? this.hash.digest("hex") : this.hash.copy().digest("hex"),
      ...(this.blobRef ? { blobRef: this.blobRef } : {}),
      ...(this.blobError ? { blobError: this.blobError } : {}),
    }
    if (final) this.result = result
    return result
  }

  snapshot() {
    return this.makeResult()
  }

  async flush() {
    if (!this.closed) {
      this.closed = true
      await this.enqueue
      this.queue?.close()
      await this.blobTask
    }
    return this.makeResult(true)
  }

  async cancel() {
    return this.flush()
  }
}

export function createOutputRetention(options: OutputRetentionOptions): OutputRetention {
  return new Retention(options)
}

export async function retainOutput(
  source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  options: OutputRetentionOptions,
) {
  const retention = createOutputRetention(options)
  try {
    for await (const chunk of source) await retention.append(chunk)
    return await retention.flush()
  } catch (error) {
    await retention.cancel()
    throw error
  }
}

export function modelOutputSummary(result: OutputRetentionResult) {
  if (!result.truncated) return result.preview
  const recovery = result.blobRef
    ? `Full output is recoverable via blob ref ${result.blobRef}.`
    : `The full output is unavailable because the spill failed${result.blobError ? `: ${result.blobError}` : "."}`
  return `${result.preview}\n\n[tool output truncated: bytesSeen=${result.bytesSeen} bytesRetained=${result.bytesRetained} sha256=${result.sha256}]\n${recovery}`
}

export const DEFAULT_OUTPUT_MAX_BYTES = 50 * 1024
export const DEFAULT_OUTPUT_PREVIEW_BYTES = 4 * 1024

export * as OutputRetention from "./output-retention"
