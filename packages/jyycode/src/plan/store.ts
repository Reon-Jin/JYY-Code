import fs from "node:fs"
import path from "node:path"
import { PlanProtocolError, ERROR_CODES, type PlanFile, assertPlanFile, clonePlan, readPlanFileSync } from "./schema"

export const WAIT_TIMEOUT_MS = 10_000
export const AGING_MS = 30_000
export const STALE_LOCK_MS = 10_000
export const CORRUPT_LOCK_GRACE_MS = 1_000
export const REPORT_RETRY_MAX = 2

export type Priority = "high" | "normal"

export type WriteContext = {
  planPath: string
  holder: string
  priority: Priority
}

export type WriteOutcome<T> = {
  mutate(plan: PlanFile): void
  result: T
}

export type WriteRequest<T> = {
  priority: Priority
  holder: string
  retryableOnTimeout?: boolean
  apply(latest: PlanFile | null, ctx: WriteContext): WriteOutcome<T>
}

type QueueItem<T> = {
  request: WriteRequest<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  enqueuedAt: number
  deadline: number
}

type QueueState = {
  active: boolean
  items: QueueItem<unknown>[]
}

type PlanStoreOptions = {
  waitTimeoutMs?: number
  agingMs?: number
  staleLockMs?: number
  corruptLockGraceMs?: number
  pollMs?: number
  now?: () => number
  pid?: number
  isProcessAlive?: (pid: number) => boolean
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function isLockStale(value: unknown, now: number, staleLockMs: number) {
  if (!value || typeof value !== "object") return false
  const acquiredAt = Date.parse(String((value as Record<string, unknown>).acquired_at ?? ""))
  return Number.isFinite(acquiredAt) && now - acquiredAt >= staleLockMs
}

function lockPid(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const pid = Number((value as Record<string, unknown>).pid)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

type PlanCandidate = {
  path: string
  plan: PlanFile
  mtimeMs: number
}

function recoveryPaths(planPath: string) {
  const dir = path.dirname(planPath)
  const base = path.basename(planPath)
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return { tempPath: `${planPath}.tmp`, backups: [] as string[] }
  }
  return {
    tempPath: `${planPath}.tmp`,
    backups: entries
      .filter((entry) => entry === `${base}.bak` || entry.startsWith(`${base}.bak.`))
      .map((entry) => path.join(dir, entry)),
  }
}

function readCandidate(candidatePath: string): PlanCandidate | null {
  if (!fs.existsSync(candidatePath)) return null
  try {
    const plan = readPlanFileSync(candidatePath)
    if (!plan) return null
    return { path: candidatePath, plan, mtimeMs: fs.statSync(candidatePath).mtimeMs }
  } catch {
    return null
  }
}

function compareCandidates(left: PlanCandidate, right: PlanCandidate) {
  return (
    left.plan.revision - right.plan.revision ||
    Date.parse(left.plan.updated_at) - Date.parse(right.plan.updated_at) ||
    left.mtimeMs - right.mtimeMs
  )
}

export class PlanStore {
  private readonly queues = new Map<string, QueueState>()
  private readonly waitTimeoutMs: number
  private readonly agingMs: number
  private readonly staleLockMs: number
  private readonly corruptLockGraceMs: number
  private readonly pollMs: number
  private readonly now: () => number
  private readonly pid: number
  private readonly isProcessAlive: (pid: number) => boolean

  constructor(options: PlanStoreOptions = {}) {
    this.waitTimeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS
    this.agingMs = options.agingMs ?? AGING_MS
    this.staleLockMs = options.staleLockMs ?? STALE_LOCK_MS
    this.corruptLockGraceMs = options.corruptLockGraceMs ?? CORRUPT_LOCK_GRACE_MS
    this.pollMs = options.pollMs ?? 10
    this.now = options.now ?? Date.now
    this.pid = options.pid ?? process.pid
    this.isProcessAlive =
      options.isProcessAlive ??
      ((pid) => {
        if (pid === process.pid) return true
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      })
  }

  read(planPath: string): PlanFile | null {
    const recovery = recoveryPaths(planPath)
    const candidates = [planPath, recovery.tempPath, ...recovery.backups]
      .map(readCandidate)
      .filter((candidate): candidate is PlanCandidate => candidate !== null)
    if (candidates.length > 0) return candidates.sort(compareCandidates).at(-1)!.plan
    return readPlanFileSync(planPath)
  }

  async enqueueWrite<T>(planPath: string, request: WriteRequest<T>): Promise<T> {
    const state = this.queues.get(planPath) ?? { active: false, items: [] }
    this.queues.set(planPath, state)
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        request,
        resolve,
        reject,
        enqueuedAt: this.now(),
        deadline: this.now() + this.waitTimeoutMs,
      }
      if (request.priority === "high") {
        const firstNormal = state.items.findIndex((queued) => queued.request.priority === "normal")
        if (firstNormal < 0) state.items.push(item as QueueItem<unknown>)
        else state.items.splice(firstNormal, 0, item as QueueItem<unknown>)
      } else {
        state.items.push(item as QueueItem<unknown>)
      }
      void this.drain(planPath, state)
    })
  }

  private async drain(planPath: string, state: QueueState) {
    if (state.active) return
    state.active = true
    try {
      while (state.items.length) {
        const index = this.nextIndex(state.items)
        const item = state.items.splice(index, 1)[0]!
        if (this.now() > item.deadline) {
          item.reject(this.timeoutError(planPath, item.request.retryableOnTimeout === true))
          continue
        }
        try {
          item.resolve(await this.runWrite(planPath, item.request))
        } catch (error) {
          item.reject(error)
        }
      }
    } finally {
      state.active = false
      if (state.items.length === 0) this.queues.delete(planPath)
    }
  }

  private nextIndex(items: QueueItem<unknown>[]) {
    const now = this.now()
    let best = 0
    let bestPriority = items[0]!.request.priority === "high" ? 1 : 0
    for (let index = 1; index < items.length; index++) {
      const item = items[index]!
      const aged = item.request.priority === "normal" && now - item.enqueuedAt >= this.agingMs
      const priority = item.request.priority === "high" || aged ? 1 : 0
      if (priority > bestPriority) {
        best = index
        bestPriority = priority
      }
    }
    return best
  }

  private timeoutError(planPath: string, retryable: boolean) {
    return new PlanProtocolError({
      code: ERROR_CODES.REVISION_CONFLICT,
      message: "写队列等待超时",
      hint: retryable ? "写冲突，请用同一 run_id 与相同参数重发" : "以最新 plan 为准重新决策，不要机械重发原 patch",
      retryable,
      latest_plan: this.read(planPath) ?? undefined,
      latest_revision: this.read(planPath)?.revision,
    })
  }

  private async runWrite<T>(planPath: string, request: WriteRequest<T>): Promise<T> {
    const lockPath = `${planPath}.lock`
    const lock = await this.acquireLock(lockPath, request.holder, request.retryableOnTimeout === true)
    try {
      const latest = this.read(planPath)
      const outcome = request.apply(latest, {
        planPath,
        holder: request.holder,
        priority: request.priority,
      })
      if (latest === null) {
        const created = {} as PlanFile
        outcome.mutate(created)
        assertPlanFile(created)
        this.writeAtomic(planPath, created)
      } else {
        const next = clonePlan(latest)
        outcome.mutate(next)
        assertPlanFile(next)
        this.writeAtomic(planPath, next)
      }
      return outcome.result
    } finally {
      this.releaseLock(lockPath, lock)
    }
  }

  private async acquireLock(lockPath: string, holder: string, retryableOnTimeout: boolean) {
    const started = this.now()
    while (true) {
      try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true })
        const fd = fs.openSync(lockPath, "wx")
        const value = {
          pid: this.pid,
          holder,
          acquired_at: new Date(this.now()).toISOString(),
        }
        const payload = JSON.stringify(value)
        try {
          fs.writeFileSync(fd, payload)
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        return value
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        this.reclaimStaleLock(lockPath)
        if (this.now() - started >= this.waitTimeoutMs)
          throw this.timeoutError(lockPath.slice(0, -5), retryableOnTimeout)
        await sleep(this.pollMs)
      }
    }
  }

  private reclaimStaleLock(lockPath: string) {
    let value: unknown
    try {
      value = JSON.parse(fs.readFileSync(lockPath, "utf8"))
    } catch {
      if (!this.corruptLockIsOld(lockPath)) return
      this.quarantineLock(lockPath)
      return
    }
    if (!this.validLockValue(value)) {
      if (this.corruptLockIsOld(lockPath)) this.quarantineLock(lockPath)
      return
    }
    if (!isLockStale(value, this.now(), this.staleLockMs)) return
    const pid = lockPid(value)
    if (pid !== undefined && this.isProcessAlive(pid)) return
    this.quarantineLock(lockPath)
  }

  private validLockValue(value: unknown): value is { pid: number; holder: string; acquired_at: string } {
    if (!value || typeof value !== "object") return false
    const record = value as Record<string, unknown>
    return (
      lockPid(value) !== undefined &&
      typeof record.holder === "string" &&
      record.holder.length > 0 &&
      typeof record.acquired_at === "string" &&
      Number.isFinite(Date.parse(record.acquired_at))
    )
  }

  private corruptLockIsOld(lockPath: string) {
    try {
      const age = this.now() - fs.statSync(lockPath).mtimeMs
      return age >= this.staleLockMs + this.corruptLockGraceMs
    } catch {
      return false
    }
  }

  private quarantineLock(lockPath: string) {
    const quarantinePath = `${lockPath}.quarantine.${this.pid}.${this.now()}.${Math.random().toString(16).slice(2)}`
    try {
      fs.renameSync(lockPath, quarantinePath)
      fs.rmSync(quarantinePath, { force: true })
    } catch {
      // Another process won the race to quarantine it, or the lock vanished.
    }
  }

  private releaseLock(lockPath: string, lock: { pid: number; holder: string }) {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>
      if (current.pid !== lock.pid || current.holder !== lock.holder) return
      fs.unlinkSync(lockPath)
    } catch {
      // Keep the original write result/error. A stale-lock pass will recover it.
    }
  }

  private writeAtomic(planPath: string, plan: PlanFile) {
    const dir = path.dirname(planPath)
    fs.mkdirSync(dir, { recursive: true })
    const tempPath = `${planPath}.tmp`
    const fd = fs.openSync(tempPath, "w")
    try {
      fs.writeFileSync(fd, JSON.stringify(plan, null, 2) + "\n", "utf8")
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.renameSync(tempPath, planPath)
    } catch (error) {
      // Windows refuses to replace an existing file with rename(). Keep the
      // normal atomic path where supported and use a recoverable handoff there.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM")
        throw error
      const backupPath = this.nextBackupPath(planPath)
      fs.renameSync(planPath, backupPath)
      try {
        fs.renameSync(tempPath, planPath)
      } catch (handoffError) {
        // Keep both complete files. PlanStore.read() will select the newest
        // valid candidate on the next operation, so a failed second rename
        // cannot turn the replacement into data loss.
        throw handoffError
      }
    }
    this.cleanupBackups(planPath)
  }

  private nextBackupPath(planPath: string) {
    const stem = `${planPath}.bak.${this.pid}.${this.now()}`
    let candidate = stem
    let suffix = 0
    while (fs.existsSync(candidate)) candidate = `${stem}.${++suffix}`
    return candidate
  }

  private cleanupBackups(planPath: string) {
    for (const backupPath of recoveryPaths(planPath).backups) {
      try {
        fs.unlinkSync(backupPath)
      } catch {
        // A leftover backup remains recoverable and can be cleaned up later.
      }
    }
  }
}

export const defaultPlanStore = new PlanStore()

export * as PlanStoreModule from "./store"
