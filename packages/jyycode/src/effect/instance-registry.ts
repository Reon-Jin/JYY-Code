import * as Log from "@jyycode-ai/core/util/log"
import { withTimeout } from "@/util/timeout"

const log = Log.create({ service: "instance-registry" })
const disposers = new Set<(directory: string) => Promise<void>>()

export const DEFAULT_INSTANCE_DISPOSER_TIMEOUT_MS = 5_000

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string, timeoutMs = DEFAULT_INSTANCE_DISPOSER_TIMEOUT_MS) {
  const results = await Promise.allSettled(
    [...disposers].map((disposer) =>
      withTimeout(disposer(directory), timeoutMs, `instance disposer timed out after ${timeoutMs}ms`),
    ),
  )

  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("instance disposer failed or timed out", {
        directory,
        timeoutMs,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    }
  }
}
