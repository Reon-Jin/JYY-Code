import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "@jyycode-ai/core/global"

const DEFAULT_STALE_MS = 60_000
const DEFAULT_RETRY_MS = 50
const DEFAULT_LOCK_DIRECTORY = path.join(Global.Path.data, "file-locks")

type LockMetadata = {
  path: string
  holder: string
  pid: number
  acquired_at: string
  token: string
  hostname: string
}

export type LockHandle = {
  waitedMs: number
  release(): void
}

export type FileWriteLockOptions = {
  directory?: string
  staleMs?: number
  retryMs?: number
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function normalizedPath(filePath: string) {
  const resolved = path.resolve(filePath)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function lockKey(filePath: string) {
  return createHash("sha256").update(normalizedPath(filePath)).digest("hex")
}

export function lockPathFor(filePath: string, directory = DEFAULT_LOCK_DIRECTORY) {
  return path.join(directory, `${lockKey(filePath)}.lock`)
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"))
    }

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = errorCode(error)
    return code !== "ESRCH" && code !== "EINVAL"
  }
}

function readMetadata(lockPath: string): LockMetadata | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"))
    if (typeof value !== "object" || value === null) return
    const data = value as Record<string, unknown>
    if (
      typeof data.path !== "string" ||
      typeof data.holder !== "string" ||
      typeof data.pid !== "number" ||
      typeof data.acquired_at !== "string" ||
      typeof data.token !== "string" ||
      typeof data.hostname !== "string"
    ) {
      return
    }
    return data as LockMetadata
  } catch {
    return
  }
}

function isStale(lockPath: string, staleMs: number) {
  let stat: fs.Stats
  try {
    stat = fs.statSync(lockPath)
  } catch {
    return false
  }

  const metadata = readMetadata(lockPath)
  const acquiredAt = metadata ? Date.parse(metadata.acquired_at) : Number.NaN
  const age = Date.now() - (Number.isFinite(acquiredAt) ? acquiredAt : stat.mtimeMs)
  if (age < staleMs) return false
  if (!metadata) return true
  if (metadata.hostname !== os.hostname()) return false
  return !processIsAlive(metadata.pid)
}

function reclaimStale(lockPath: string, staleMs: number) {
  if (!isStale(lockPath, staleMs)) return
  try {
    fs.unlinkSync(lockPath)
  } catch (error) {
    const code = errorCode(error)
    if (code !== "ENOENT") throw error
  }
}

export class FileWriteLock {
  readonly directory: string
  readonly staleMs: number
  readonly retryMs: number

  constructor(options: FileWriteLockOptions = {}) {
    this.directory = options.directory ?? DEFAULT_LOCK_DIRECTORY
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  }

  async acquire(filePath: string, input: { holder: string; signal?: AbortSignal }): Promise<LockHandle> {
    const normalized = normalizedPath(filePath)
    const lockPath = lockPathFor(filePath, this.directory)
    const startedAt = Date.now()

    fs.mkdirSync(this.directory, { recursive: true })

    while (true) {
      input.signal?.throwIfAborted()
      const token = randomUUID()
      const metadata: LockMetadata = {
        path: normalized,
        holder: input.holder,
        pid: process.pid,
        acquired_at: new Date().toISOString(),
        token,
        hostname: os.hostname(),
      }

      try {
        const fd = fs.openSync(lockPath, "wx", 0o600)
        try {
          fs.writeFileSync(fd, JSON.stringify(metadata), "utf8")
        } finally {
          fs.closeSync(fd)
        }

        if (input.signal?.aborted) {
          this.release(lockPath, metadata)
          input.signal.throwIfAborted()
        }

        let released = false
        return {
          waitedMs: Date.now() - startedAt,
          release: () => {
            if (released) return
            released = true
            this.release(lockPath, metadata)
          },
        }
      } catch (error) {
        const code = errorCode(error)
        if (code !== "EEXIST") throw error
        reclaimStale(lockPath, this.staleMs)
      }

      await sleep(this.retryMs, input.signal)
    }
  }

  private release(lockPath: string, owner: LockMetadata) {
    const current = readMetadata(lockPath)
    if (
      !current ||
      current.token !== owner.token ||
      current.holder !== owner.holder ||
      current.pid !== owner.pid ||
      current.path !== owner.path
    ) {
      return
    }

    try {
      fs.unlinkSync(lockPath)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
  }
}

export const fileWriteLock = new FileWriteLock()

export * as WriteLock from "./write-lock"
