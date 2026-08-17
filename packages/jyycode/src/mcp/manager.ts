import { createHash } from "node:crypto"
import path from "node:path"

export const DEFAULT_MCP_IDLE_TTL_MS = 2 * 60 * 1000
export const DEFAULT_MCP_MAX_CONCURRENCY = 4
export const MAX_MCP_MAX_CONCURRENCY = 16

export interface MCPLeaseKeyInput {
  readonly worktree: string
  readonly server?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly config?: unknown
  readonly securityScope?: string
}

export interface MCPManagerOptions {
  readonly idleTtlMs?: number
  readonly maxConcurrency?: number
  readonly now?: () => number
}

export interface MCPLease<T> {
  readonly key: string
  readonly value: T
  release(): Promise<void>
  dispose(): Promise<void>
}

export interface MCPSweepResult {
  readonly closed: number
  readonly degraded: number
}

interface ReadyEntry<T> {
  readonly kind: "ready"
  readonly key: string
  readonly value: T
  readonly close: (value: T) => Promise<void>
  refs: number
  lastUsedAt: number
}

interface StartingEntry<T> {
  readonly kind: "starting"
  readonly promise: Promise<ReadyEntry<T>>
}

interface DegradedEntry<T> {
  readonly key: string
  readonly value: T
  readonly close: (value: T) => Promise<void>
  nextRetryAt: number
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    )
  }
  return value
}

function fingerprint(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)) ?? "null")
    .digest("hex")
}

function canonicalWorktree(worktree: string) {
  const resolved = path.resolve(worktree)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/**
 * Produce a non-secret pool key. Environment values and config are hashed so
 * credentials cannot leak through pool diagnostics or heap snapshots.
 */
export function canonicalMCPLeaseKey(input: MCPLeaseKeyInput) {
  return fingerprint({
    worktree: canonicalWorktree(input.worktree),
    server: input.server ?? "",
    command: input.command ?? "",
    args: input.args ?? [],
    environment: fingerprint(input.environment ?? {}),
    config: fingerprint(input.config ?? {}),
    securityScope: input.securityScope ?? "default",
  })
}

function normalizeConcurrency(value: number | undefined) {
  return Math.max(1, Math.min(MAX_MCP_MAX_CONCURRENCY, Math.floor(value ?? DEFAULT_MCP_MAX_CONCURRENCY)))
}

function normalizeTtl(value: number | undefined) {
  return Math.max(1, Math.floor(value ?? DEFAULT_MCP_IDLE_TTL_MS))
}

/**
 * A small async resource pool for MCP clients. It deduplicates identical
 * starts, bounds new starts, and keeps released resources warm for a bounded
 * idle period. A failed close is retained as a degraded entry for retry.
 */
export class MCPServerManager<T> {
  readonly idleTtlMs: number
  readonly maxConcurrency: number

  private readonly now: () => number
  private readonly entries = new Map<string, ReadyEntry<T> | StartingEntry<T>>()
  private readonly degraded = new Map<string, DegradedEntry<T>>()
  private readonly waiters: Array<() => void> = []
  private activeStarts = 0

  constructor(options: MCPManagerOptions = {}) {
    this.idleTtlMs = normalizeTtl(options.idleTtlMs)
    this.maxConcurrency = normalizeConcurrency(options.maxConcurrency)
    this.now = options.now ?? Date.now
  }

  async acquire(
    keyInput: string | MCPLeaseKeyInput,
    start: () => Promise<T>,
    close: (value: T) => Promise<void>,
  ): Promise<MCPLease<T>> {
    const key = typeof keyInput === "string" ? keyInput : canonicalMCPLeaseKey(keyInput)
    const existing = this.entries.get(key)
    if (existing?.kind === "ready") return this.lease(existing)
    if (existing?.kind === "starting") {
      const ready = await existing.promise
      return this.lease(ready)
    }

    const promise = this.startEntry(key, start, close)
    this.entries.set(key, { kind: "starting", promise })
    const ready = await promise
    return this.lease(ready)
  }

  async acquirePermit(): Promise<{ release: () => void }> {
    if (this.activeStarts < this.maxConcurrency) {
      this.activeStarts++
      return this.permit()
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.activeStarts++
    return this.permit()
  }

  async sweep(now = this.now()): Promise<MCPSweepResult> {
    let closed = 0
    let degraded = 0
    for (const [key, entry] of this.entries) {
      if (entry.kind !== "ready" || entry.refs !== 0 || now - entry.lastUsedAt < this.idleTtlMs) continue
      this.entries.delete(key)
      try {
        await entry.close(entry.value)
        closed++
      } catch {
        this.degraded.set(key, {
          key,
          value: entry.value,
          close: entry.close,
          nextRetryAt: now + this.idleTtlMs,
        })
        degraded++
      }
    }

    for (const [key, entry] of this.degraded) {
      if (now < entry.nextRetryAt) continue
      try {
        await entry.close(entry.value)
        this.degraded.delete(key)
        closed++
      } catch {
        entry.nextRetryAt = now + this.idleTtlMs
        degraded++
      }
    }
    return { closed, degraded }
  }

  async closeAll(): Promise<MCPSweepResult> {
    let closed = 0
    let degraded = 0
    const entries = [...this.entries.values()]
    const degradedEntries = [...this.degraded.values()]
    this.entries.clear()
    this.degraded.clear()
    for (const entry of entries) {
      if (entry.kind === "starting") continue
      try {
        await entry.close(entry.value)
        closed++
      } catch {
        degraded++
      }
    }
    for (const entry of degradedEntries) {
      try {
        await entry.close(entry.value)
        closed++
      } catch {
        degraded++
      }
    }
    return { closed, degraded }
  }

  size() {
    return this.entries.size
  }

  degradedSize() {
    return this.degraded.size
  }

  private async startEntry(key: string, start: () => Promise<T>, close: (value: T) => Promise<void>) {
    const permit = await this.acquirePermit()
    try {
      const value = await start()
      const ready: ReadyEntry<T> = {
        kind: "ready",
        key,
        value,
        close,
        refs: 0,
        lastUsedAt: this.now(),
      }
      this.entries.set(key, ready)
      return ready
    } catch (error) {
      if (this.entries.get(key)?.kind === "starting") this.entries.delete(key)
      throw error
    } finally {
      permit.release()
    }
  }

  private lease(entry: ReadyEntry<T>): MCPLease<T> {
    entry.refs++
    entry.lastUsedAt = this.now()
    let released = false
    return {
      key: entry.key,
      value: entry.value,
      release: async () => {
        if (released) return
        released = true
        entry.refs = Math.max(0, entry.refs - 1)
        entry.lastUsedAt = this.now()
      },
      dispose: async () => {
        if (released) return
        released = true
        entry.refs = Math.max(0, entry.refs - 1)
        entry.lastUsedAt = this.now() - this.idleTtlMs
        await this.sweep(this.now())
      },
    }
  }

  private permit() {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.activeStarts = Math.max(0, this.activeStarts - 1)
        this.waiters.shift()?.()
      },
    }
  }
}

export * as MCPManager from "./manager"
