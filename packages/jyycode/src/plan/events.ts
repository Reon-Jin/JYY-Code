import type { PlanFile } from "./schema"

export type PlanEventType = "plan.updated" | "child.activity" | "report_arrived" | "check_point" | "user_message"

export type PlanEvent = {
  seq: number
  type: PlanEventType
  session_id: string
  revision?: number
  at: string
  payload: Record<string, unknown>
}

export type PlanEventListener = (event: PlanEvent) => void

export function validatePlanEvent(value: unknown): string[] {
  const errors: string[] = []
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["event: must be an object"]
  const event = value as Record<string, unknown>
  for (const field of ["seq", "type", "session_id", "at", "payload"])
    if (!(field in event)) errors.push(`event.${field}: is required`)
  if (!Number.isInteger(event.seq) || Number(event.seq) < 0) errors.push("event.seq: must be an integer >= 0")
  if (!["plan.updated", "child.activity", "report_arrived", "check_point", "user_message"].includes(String(event.type)))
    errors.push("event.type: invalid event type")
  if (typeof event.session_id !== "string" || event.session_id.length === 0)
    errors.push("event.session_id: must be non-empty")
  if (typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at)))
    errors.push("event.at: must be an ISO date-time")
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload))
    errors.push("event.payload: must be an object")
  if (event.type === "plan.updated" && !Number.isInteger(event.revision))
    errors.push("event.revision: required for plan.updated")
  return errors
}

type Subscription = { sessionId: string; listener: PlanEventListener }

export class PlanEventHub {
  private readonly sequences = new Map<string, number>()
  private readonly subscriptions = new Set<Subscription>()

  publish(input: Omit<PlanEvent, "seq" | "at"> & { at?: string }) {
    const seq = (this.sequences.get(input.session_id) ?? -1) + 1
    this.sequences.set(input.session_id, seq)
    const event: PlanEvent = {
      ...input,
      seq,
      at: input.at ?? new Date().toISOString(),
    }
    for (const subscription of [...this.subscriptions]) {
      if (subscription.sessionId !== event.session_id) continue
      try {
        subscription.listener(event)
      } catch {
        // Event consumers must not be able to break persistence callers.
      }
    }
    return event
  }

  subscribe(sessionId: string, listener: PlanEventListener) {
    const subscription = { sessionId, listener }
    this.subscriptions.add(subscription)
    return () => this.subscriptions.delete(subscription)
  }

  lastSequence(sessionId: string) {
    return this.sequences.get(sessionId) ?? -1
  }
}

export type WakeupEvent = PlanEvent & { type: "report_arrived" | "check_point" | "user_message" }

export class WakeupQueue {
  private readonly queues = new Map<string, WakeupEvent[]>()

  push(event: WakeupEvent) {
    const queue = this.queues.get(event.session_id) ?? []
    if (event.type === "report_arrived") {
      const existing = queue.find((item) => item.type === "report_arrived")
      if (existing) {
        const current = Array.isArray(existing.payload.items) ? existing.payload.items : []
        const incoming = Array.isArray(event.payload.items) ? event.payload.items : [event.payload]
        existing.payload = { ...existing.payload, items: [...current, ...incoming] }
      } else {
        queue.push({ ...event, payload: { items: [event.payload] } })
      }
    } else {
      queue.push(event)
    }
    queue.sort((left, right) => {
      const priority = (item: WakeupEvent) =>
        item.type === "user_message" ? 0 : item.type === "report_arrived" ? 1 : 2
      return priority(left) - priority(right) || left.seq - right.seq
    })
    this.queues.set(event.session_id, queue)
  }

  drain(sessionId: string) {
    const items = this.queues.get(sessionId) ?? []
    this.queues.delete(sessionId)
    return items
  }

  pending(sessionId: string) {
    return this.queues.get(sessionId)?.length ?? 0
  }
}

export type InboxEntry = {
  id: string
  session_id: string
  task_id?: string
  run_id?: string
  kind: "report_precheck_failed" | "cancelled" | "runtime_error"
  message: string
  step_id?: string
  task_title?: string
  report?: {
    status: "done" | "partial" | "failed"
    summary: string
    issues: string[]
    reported_at: string
  }
  suggested_actions?: string[]
  created_at: string
  resolved_at: string | null
}

export class PlanInbox {
  private readonly entries = new Map<string, InboxEntry[]>()
  private counter = 0

  add(entry: Omit<InboxEntry, "id" | "created_at" | "resolved_at">) {
    const item: InboxEntry = {
      ...entry,
      id: `inbox_${++this.counter}`,
      created_at: new Date().toISOString(),
      resolved_at: null,
    }
    this.entries.set(entry.session_id, [...(this.entries.get(entry.session_id) ?? []), item])
    return item
  }

  list(sessionId: string) {
    return [...(this.entries.get(sessionId) ?? [])]
  }

  pending(sessionId: string) {
    return this.list(sessionId).filter((entry) => entry.resolved_at === null)
  }

  pendingCount(sessionId: string) {
    return this.pending(sessionId).length
  }

  resolve(sessionId: string, id: string) {
    const entries = this.entries.get(sessionId) ?? []
    const target = entries.find((entry) => entry.id === id)
    if (target) target.resolved_at = new Date().toISOString()
    return target
  }
}

export const defaultPlanEvents = new PlanEventHub()
export const defaultWakeupQueue = new WakeupQueue()
export const defaultPlanInbox = new PlanInbox()

export function emitPlanUpdated(
  hub: PlanEventHub,
  sessionId: string,
  plan: PlanFile,
  payload: Record<string, unknown>,
) {
  return hub.publish({
    type: "plan.updated",
    session_id: sessionId,
    revision: plan.revision,
    payload,
  })
}

export * as PlanEvents from "./events"
