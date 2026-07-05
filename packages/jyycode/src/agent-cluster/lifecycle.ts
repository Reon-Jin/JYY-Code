export * as AgentClusterLifecycle from "./lifecycle"

import type { RunStatus, TaskStatus } from "./schema"

const TASK_TRANSITIONS = {
  planned: ["queued"],
  queued: ["running", "cancelled", "failed"],
  running: ["submitted", "failed", "cancelled"],
  submitted: ["reviewing", "failed", "cancelled"],
  reviewing: ["accepted", "revision_requested", "failed", "cancelled"],
  accepted: [],
  revision_requested: ["revising", "failed", "cancelled"],
  revising: ["submitted", "failed", "cancelled"],
  failed: [],
  cancelled: [],
} as const satisfies Record<TaskStatus, readonly TaskStatus[]>

const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["accepted", "failed", "cancelled"]

const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "revising"]

const REVIEW_TASK_STATUSES: readonly TaskStatus[] = ["submitted", "reviewing", "revision_requested"]

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = TASK_TRANSITIONS[from]
  return (allowed as readonly string[]).includes(to)
}

export function isTerminalTask(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status)
}

export function deriveRunStatus(taskStatuses: readonly TaskStatus[]): RunStatus {
  if (taskStatuses.length === 0) return "planning"

  const hasActive = taskStatuses.some((s) => (ACTIVE_TASK_STATUSES as readonly string[]).includes(s))
  if (hasActive) return "dispatching"

  const hasReview = taskStatuses.some((s) => (REVIEW_TASK_STATUSES as readonly string[]).includes(s))
  if (hasReview) return "reviewing"

  const allTerminal = taskStatuses.every((s) => (TERMINAL_TASK_STATUSES as readonly string[]).includes(s))
  if (!allTerminal) return "dispatching"

  const hasAccepted = taskStatuses.some((s) => s === "accepted")
  if (hasAccepted) return "completed"

  // All failed/cancelled with no accepted
  return "failed"
}
