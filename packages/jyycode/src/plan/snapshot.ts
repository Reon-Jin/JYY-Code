import type { ProfileSnapshot } from "@/agent/subagent-profile"
import type { PlanFile, PlanTask } from "./schema"

export type ActivityState = {
  activity: string
  at: string
  started_at?: string
}

export type PlanSnapshotTask = {
  id: string
  title: string
  status: PlanTask["status"]
  role?: ProfileSnapshot
  child?: {
    session_id: string
    elapsed_sec: number
    last_activity?: string
    last_activity_at?: string
  }
}

export type PlanSnapshot = {
  title: string
  goal: string
  status: PlanFile["status"]
  revision: number
  current_step: string | null
  steps: Array<{
    id: string
    title: string
    status: PlanFile["steps"][number]["status"]
    tasks: PlanSnapshotTask[]
  }>
  pending_review: number
  inbox_pending: number
}

export function validatePlanSnapshot(value: unknown): string[] {
  const errors: string[] = []
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["snapshot: must be an object"]
  const snapshot = value as Record<string, unknown>
  for (const field of [
    "title",
    "goal",
    "status",
    "revision",
    "current_step",
    "steps",
    "pending_review",
    "inbox_pending",
  ]) {
    if (!(field in snapshot)) errors.push(`snapshot.${field}: is required`)
  }
  if (typeof snapshot.title !== "string" || !snapshot.title) errors.push("snapshot.title: must be non-empty")
  if (typeof snapshot.goal !== "string" || !snapshot.goal) errors.push("snapshot.goal: must be non-empty")
  if (!["draft", "active", "done"].includes(String(snapshot.status))) errors.push("snapshot.status: invalid")
  if (!Number.isInteger(snapshot.revision) || Number(snapshot.revision) < 1) errors.push("snapshot.revision: invalid")
  if (snapshot.current_step !== null && typeof snapshot.current_step !== "string")
    errors.push("snapshot.current_step: invalid")
  if (!Array.isArray(snapshot.steps)) errors.push("snapshot.steps: must be an array")
  if (!Number.isInteger(snapshot.pending_review) || Number(snapshot.pending_review) < 0)
    errors.push("snapshot.pending_review: invalid")
  if (!Number.isInteger(snapshot.inbox_pending) || Number(snapshot.inbox_pending) < 0)
    errors.push("snapshot.inbox_pending: invalid")
  return errors
}

export function projectPlanSnapshot(
  plan: PlanFile | null,
  options: {
    inboxPending?: number
    now?: number
    activities?: ReadonlyMap<string, ActivityState>
  } = {},
): PlanSnapshot | { plan: null } {
  if (!plan) return { plan: null }
  const now = options.now ?? Date.now()
  const activities = options.activities ?? new Map()
  const pendingReview = plan.steps.flatMap((step) => step.tasks).filter((task) => task.status === "reported").length
  return {
    title: plan.title,
    goal: plan.goal,
    status: plan.status,
    revision: plan.revision,
    current_step: plan.current_step,
    steps: plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      tasks: step.tasks.map((task) => {
        const activity = activities.get(task.id)
        if (!task.dispatch) {
          return { id: task.id, title: task.title, status: task.status }
        }
        const elapsedStart = Date.parse(activity?.started_at ?? task.dispatch.dispatched_at)
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          ...(task.dispatch.role ? { role: task.dispatch.role } : {}),
          child: {
            session_id: task.dispatch.child_session_id,
            elapsed_sec: Number.isFinite(elapsedStart) ? Math.max(0, Math.floor((now - elapsedStart) / 1000)) : 0,
            ...(activity ? { last_activity: activity.activity, last_activity_at: activity.at } : {}),
          },
        }
      }),
    })),
    pending_review: pendingReview,
    inbox_pending: options.inboxPending ?? 0,
  }
}

export * as PlanSnapshot from "./snapshot"
