import path from "node:path"
import type { ChildTerminationResult } from "./child-termination"

export type CleanupState = "pending" | "stopping" | "deleting" | "failed" | "quarantined" | "completed"

export type CleanupError = {
  phase: string
  code?: string
  message: string
}

export type CleanupRecord = {
  state: CleanupState
  attempts: number
  updated_at: string
  next_retry_at?: string
  last_error?: CleanupError
}

export type CleanupStopResult = ChildTerminationResult | void

export type WorkspaceCleanupInput = {
  rootSessionId: string
  taskId: string
  workspaceDirectory?: string | null
  record?: CleanupRecord
  now?: () => number
  stop?: () => Promise<CleanupStopResult>
  /** A shared_compat child has no directory to remove, but still has a stop phase. */
  deleteWorkspace?: boolean
  remove?: () => Promise<boolean | void>
  persist: (record: CleanupRecord) => Promise<void>
}

export type WorkspaceCleanupResult = {
  record: CleanupRecord
  changed: boolean
}

export const CLEANUP_RETRY_DELAY_MS = 1_000

function nowIso(now: () => number) {
  return new Date(now()).toISOString()
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function isUnsafe(error: unknown) {
  return (
    (error && typeof error === "object" && "recoverable" in error && error.recoverable === false) ||
    ["UNSAFE_PATH", "PATH_IDENTITY_MISMATCH", "OUTSIDE_RUNTIME_ROOT"].includes(codeOf(error) ?? "")
  )
}

function keyFor(input: Pick<WorkspaceCleanupInput, "rootSessionId" | "taskId" | "workspaceDirectory">) {
  return `${input.rootSessionId}\0${input.taskId}\0${input.workspaceDirectory ? path.resolve(input.workspaceDirectory) : ""}`
}

export function cleanupRecordFromLegacy(
  status: "not_started" | "pending" | "completed" | "failed" | undefined,
  error: string | undefined,
  now = Date.now,
): CleanupRecord {
  const state: CleanupState =
    status === "completed" ? "completed" : status === "failed" ? "failed" : status === "pending" ? "pending" : "pending"
  return {
    state,
    attempts: 0,
    updated_at: nowIso(now),
    ...(error ? { last_error: { phase: "legacy", message: error } } : {}),
  }
}

export function legacyCleanupStatus(record: CleanupRecord): "not_started" | "pending" | "completed" | "failed" {
  if (record.state === "completed") return "completed"
  if (record.state === "failed" || record.state === "quarantined") return "failed"
  if (record.state === "pending" || record.state === "stopping" || record.state === "deleting") return "pending"
  return "not_started"
}

export class WorkspaceCleanupService {
  private readonly inFlight = new Map<string, Promise<WorkspaceCleanupResult>>()

  run(input: WorkspaceCleanupInput): Promise<WorkspaceCleanupResult> {
    const key = keyFor(input)
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const operation = this.execute(input).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, operation)
    return operation
  }

  private async execute(input: WorkspaceCleanupInput): Promise<WorkspaceCleanupResult> {
    const now = input.now ?? Date.now
    let record = input.record ?? cleanupRecordFromLegacy(undefined, undefined, now)
    if (record.state === "completed" || record.state === "quarantined") return { record, changed: false }

    const persist = async (next: CleanupRecord) => {
      record = next
      await input.persist(next)
    }

    const attempts = Math.max(0, record.attempts) + 1
    if (record.state !== "deleting") {
      await persist({ ...record, state: "pending", attempts, updated_at: nowIso(now) })
      await persist({ ...record, state: "stopping", attempts, updated_at: nowIso(now), next_retry_at: undefined })
      if (!input.stop) return this.fail(input, record, "stop", new Error("child stop operation is unavailable"), now)
      try {
        const stopped = await input.stop()
        if (stopped?.state === "stop_failed")
          return this.fail(input, record, "stop", new Error(`${stopped.phase}: ${stopped.message}`), now, "STOP_FAILED")
      } catch (error) {
        return this.fail(input, record, "stop", error, now)
      }
    }

    await persist({ ...record, state: "deleting", attempts, updated_at: nowIso(now), next_retry_at: undefined })
    if (input.deleteWorkspace !== false) {
      if (!input.workspaceDirectory) return this.fail(input, record, "delete", new Error("workspace directory is missing"), now)
      if (!input.remove) return this.fail(input, record, "delete", new Error("workspace remove operation is unavailable"), now)
      try {
        await input.remove()
      } catch (error) {
        return this.fail(input, record, "delete", error, now)
      }
    }

    const completed = {
      ...record,
      state: "completed" as const,
      attempts,
      updated_at: nowIso(now),
      next_retry_at: undefined,
      last_error: undefined,
    }
    await persist(completed)
    return { record: completed, changed: true }
  }

  private async fail(
    input: WorkspaceCleanupInput,
    current: CleanupRecord,
    phase: string,
    error: unknown,
    now: () => number,
    code?: string,
  ): Promise<WorkspaceCleanupResult> {
    const failed: CleanupRecord = {
      ...current,
      state: isUnsafe(error) ? "quarantined" : "failed",
      updated_at: nowIso(now),
      next_retry_at: isUnsafe(error) ? undefined : new Date(now() + CLEANUP_RETRY_DELAY_MS).toISOString(),
      last_error: { phase, ...(code ?? codeOf(error) ? { code: code ?? codeOf(error) } : {}), message: messageOf(error) },
    }
    await input.persist(failed)
    return { record: failed, changed: true }
  }
}

export const WorkspaceCleanup = WorkspaceCleanupService

export * as WorkspaceCleanupModule from "./workspace-cleanup"
