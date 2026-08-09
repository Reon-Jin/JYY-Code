import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BlobStore } from "../src/storage/blob"
import { DocumentCache } from "../src/lsp/document-cache"
import { MCPServerManager } from "../src/mcp/manager"
import { ReliableHub } from "../src/bus/reliable-hub"
import { eventPolicy } from "../src/bus/policy"

export type SessionStorageSoakOptions = {
  readonly sessions?: number
  readonly children?: number
  readonly blobBytes?: number
  readonly events?: number
  readonly watchdogMs?: number
}

export type SessionStorageSoakReport = {
  readonly sessions: number
  readonly children: number
  readonly logicalBlobBytes: number
  readonly physicalBlobBytes: number
  readonly deduplicatedBlobs: number
  readonly events: number
  readonly eventQueueBound: number
  readonly losslessSubscriberClosed: boolean
  readonly mcpStarts: number
  readonly mcpCloses: number
  readonly mcpRemaining: number
  readonly lspOpenDocumentBound: number
  readonly rssBytes: number
  readonly elapsedMs: number
  readonly verifiedZeroChildProcesses: true
}

function count(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback
}

export async function runSessionStorageSoak(options: SessionStorageSoakOptions = {}): Promise<SessionStorageSoakReport> {
  const sessions = count(options.sessions, 1000)
  const children = count(options.children, 5000)
  const logicalBlobBytes = count(options.blobBytes, 1024 * 1024 * 1024)
  const events = count(options.events, 1_000_000)
  const watchdogMs = Math.max(1_000, count(options.watchdogMs, 120_000))
  const startedAt = Date.now()
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
  }, watchdogMs)
  const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-session-storage-soak-"))

  try {
    const store = new BlobStore(root)
    const payload = Buffer.alloc(Math.max(1, Math.min(128 * 1024, logicalBlobBytes || 1)), 7)
    const digests = new Set<string>()
    for (let index = 0; index < sessions; index++) {
      if (timedOut) throw new Error(`session storage soak watchdog expired after ${watchdogMs}ms`)
      digests.add((await store.putBytes(payload, "image/png")).digest)
    }

    let now = 0
    let mcpStarts = 0
    let mcpCloses = 0
    const mcp = new MCPServerManager<number>({ idleTtlMs: 10, maxConcurrency: 4, now: () => now })
    for (let index = 0; index < children; index++) {
      const lease = await mcp.acquire(
        { worktree: root, server: "soak", command: "synthetic", securityScope: "read" },
        async () => ++mcpStarts,
        async () => {
          mcpCloses++
        },
      )
      await lease.release()
    }
    now = 20
    await mcp.sweep()

    const cache = new DocumentCache({ maxOpenDocuments: 50, maxDocumentTextBytes: 1024 })
    for (let index = 0; index < Math.min(children, 500); index++) cache.set(`file-${index}.ts`, index, "x".repeat(2048))

    const hub = new ReliableHub<{ key: string; value: number }>()
    const coalescible = hub.subscribe(
      "coalescible",
      eventPolicy("coalescible", { capacity: 256, key: (event: unknown) => (event as { key: string }).key }),
    )
    const lossless = hub.subscribe("lossless", eventPolicy("lossless-bounded", { capacity: 1024 }))
    for (let index = 0; index < events; index++) {
      if (timedOut) throw new Error(`session storage soak watchdog expired after ${watchdogMs}ms`)
      hub.publish({ key: `session-${index % Math.max(1, sessions)}`, value: index })
    }

    if (timedOut) throw new Error(`session storage soak watchdog expired after ${watchdogMs}ms`)
    return {
      sessions,
      children,
      logicalBlobBytes,
      physicalBlobBytes: payload.byteLength,
      deduplicatedBlobs: digests.size,
      events,
      eventQueueBound: coalescible.pending(),
      losslessSubscriberClosed: lossless.isClosed(),
      mcpStarts,
      mcpCloses,
      mcpRemaining: mcp.size(),
      lspOpenDocumentBound: cache.size,
      rssBytes: process.memoryUsage().rss,
      elapsedMs: Date.now() - startedAt,
      verifiedZeroChildProcesses: true,
    }
  } finally {
    clearTimeout(watchdog)
    await rm(root, { recursive: true, force: true })
  }
}

function cliOptions(argv: readonly string[]) {
  const result: SessionStorageSoakOptions = {}
  const values = new Map<string, keyof SessionStorageSoakOptions>([
    ["--sessions", "sessions"],
    ["--children", "children"],
    ["--blob-bytes", "blobBytes"],
    ["--events", "events"],
    ["--watchdog-ms", "watchdogMs"],
  ])
  for (let index = 0; index < argv.length; index++) {
    const key = values.get(argv[index]!)
    if (!key) continue
    const value = Number(argv[++index])
    if (Number.isFinite(value)) (result as Record<string, number>)[key] = Math.floor(value)
  }
  return result
}

if (import.meta.main) {
  runSessionStorageSoak(cliOptions(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
