import { Cause, Effect, Exit, Semaphore } from "effect"
import * as Log from "@jyycode-ai/core/util/log"
import { Global } from "@jyycode-ai/core/global"
import { BlobGarbageCollector } from "@/storage/blob-gc"

const log = Log.create({ service: "computer-screenshot-gc" })

// Batch physical deletion so computer actions do not repeatedly scan every
// channel database. A running process leaves at most this much newly retired
// screenshot data waiting for its next targeted collection attempt.
export const COMPUTER_SCREENSHOT_GC_BATCH_BYTES = 64 * 1024 * 1024
const RETRY_DELAY_MS = 5 * 60 * 1000

export class ComputerScreenshotCollector {
  private readonly lock = Semaphore.makeUnsafe(1)
  private readonly pending = new Map<string, number>()
  private pendingBytes = 0
  private retryAfter = 0
  private readonly root: string
  private readonly batchBytes: number

  constructor(options: { root?: string; batchBytes?: number } = {}) {
    this.root = options.root ?? Global.Path.data
    this.batchBytes = options.batchBytes ?? COMPUTER_SCREENSHOT_GC_BATCH_BYTES
    if (!Number.isSafeInteger(this.batchBytes) || this.batchBytes < 1) throw new Error("Invalid screenshot GC batch size")
  }

  collect(released: readonly { digest: string; bytes: number }[]) {
    if (released.length === 0) return Effect.void
    const collector = this
    return this.lock.withPermit(Effect.gen(function* () {
      for (const item of released) {
        if (collector.pending.has(item.digest)) continue
        collector.pending.set(item.digest, item.bytes)
        collector.pendingBytes += item.bytes
      }
      if (collector.pendingBytes < collector.batchBytes || Date.now() < collector.retryAfter) return

      const digests = [...collector.pending.keys()]
      const exit = yield* Effect.exit(new BlobGarbageCollector(collector.root).run({ onlyDigests: digests, graceMs: 0 }))
      if (Exit.isFailure(exit)) {
        collector.retryAfter = Date.now() + RETRY_DELAY_MS
        log.warn("screenshot blob cleanup deferred", { error: Cause.pretty(exit.cause) })
        return
      }
      for (const digest of digests) {
        collector.pendingBytes -= collector.pending.get(digest) ?? 0
        collector.pending.delete(digest)
      }
      collector.retryAfter = 0
    }))
  }
}

const collector = new ComputerScreenshotCollector()
export const collectReleasedComputerScreenshots = (released: readonly { digest: string; bytes: number }[]) =>
  collector.collect(released)
