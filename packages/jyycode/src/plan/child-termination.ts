import type { Info as SessionStatusInfo } from "@/session/status"

export const CHILD_CANCEL_TIMEOUT_MS = 15_000
export const CHILD_IDLE_TIMEOUT_MS = 15_000
export const CHILD_DISPOSE_TIMEOUT_MS = 10_000
export const CHILD_ARCHIVE_TIMEOUT_MS = 15_000
export const CHILD_STATUS_POLL_INTERVAL_MS = 50

export type ChildTerminationPhase = "cancel" | "idle" | "dispose" | "archive"

export type ChildTerminationResult =
  | { state: "stopped"; cancelled: true; idle: true; disposed: boolean; archived: true }
  | { state: "stop_failed"; phase: ChildTerminationPhase; message: string }

export type ChildTerminationWorkspace = {
  mode: "worktree" | "snapshot" | "shared_compat"
  directory?: string | null
  /** Shared-compat children use the parent instance and do not remove its workspace. */
  dispose?: boolean
}

export type ChildTerminationRequest = {
  workspace?: ChildTerminationWorkspace
}

export type ChildTerminationOperations = {
  cancel: () => Promise<void>
  status: () => Promise<SessionStatusInfo>
  disposeDirectory?: (directory: string) => Promise<void>
  archive: () => Promise<void>
  markIntent?: () => void
}

export type ChildTerminationOptions = {
  cancelTimeoutMs?: number
  idleTimeoutMs?: number
  disposeTimeoutMs?: number
  archiveTimeoutMs?: number
  pollIntervalMs?: number
  sleep?: (milliseconds: number) => Promise<void>
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number, phase: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${phase} timed out after ${milliseconds}ms`)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function failed(phase: ChildTerminationPhase, error: unknown): ChildTerminationResult {
  return { state: "stop_failed", phase, message: errorMessage(error) }
}

/**
 * The single ordering gate for child shutdown. A failed phase deliberately
 * returns without entering later phases: archiving a still-running child or
 * deleting a workspace that may still be in use is not a recoverable cleanup.
 */
export async function terminateChild(
  input: { sessionId: string; request?: ChildTerminationRequest },
  operations: ChildTerminationOperations,
  options: ChildTerminationOptions = {},
): Promise<ChildTerminationResult> {
  const cancelTimeoutMs = options.cancelTimeoutMs ?? CHILD_CANCEL_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? CHILD_IDLE_TIMEOUT_MS
  const disposeTimeoutMs = options.disposeTimeoutMs ?? CHILD_DISPOSE_TIMEOUT_MS
  const archiveTimeoutMs = options.archiveTimeoutMs ?? CHILD_ARCHIVE_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? CHILD_STATUS_POLL_INTERVAL_MS
  const wait = options.sleep ?? sleep

  operations.markIntent?.()

  try {
    await withTimeout(operations.cancel(), cancelTimeoutMs, "cancel")
  } catch (error) {
    return failed("cancel", error)
  }

  const idleDeadline = Date.now() + idleTimeoutMs
  while (true) {
    try {
      const status = await withTimeout(
        operations.status(),
        Math.max(1, idleDeadline - Date.now()),
        "idle status",
      )
      if (status.type === "idle") break
    } catch (error) {
      return failed("idle", error)
    }
    const remaining = idleDeadline - Date.now()
    if (remaining <= 0) return failed("idle", new Error(`child ${input.sessionId} did not become idle in time`))
    await wait(Math.min(pollIntervalMs, remaining))
  }

  const workspace = input.request?.workspace
  const shouldDispose = workspace?.dispose === true || (workspace && workspace.mode !== "shared_compat")
  if (shouldDispose) {
    if (!workspace?.directory) return failed("dispose", new Error("child workspace directory is missing"))
    if (!operations.disposeDirectory) return failed("dispose", new Error("instance directory disposer unavailable"))
    try {
      await withTimeout(operations.disposeDirectory(workspace.directory), disposeTimeoutMs, "dispose")
    } catch (error) {
      return failed("dispose", error)
    }
  }

  try {
    await withTimeout(operations.archive(), archiveTimeoutMs, "archive")
  } catch (error) {
    return failed("archive", error)
  }

  return { state: "stopped", cancelled: true, idle: true, disposed: shouldDispose === true, archived: true }
}

export class ChildTerminationCoordinator {
  constructor(
    private readonly operations: ChildTerminationOperations,
    private readonly options: ChildTerminationOptions = {},
  ) {}

  terminate(input: { sessionId: string; request?: ChildTerminationRequest }) {
    return terminateChild(input, this.operations, this.options)
  }
}
