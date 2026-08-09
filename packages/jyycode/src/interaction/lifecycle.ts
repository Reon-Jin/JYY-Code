export type InteractionState = "pending" | "parked" | "answered" | "cancelled" | "expired"

export type InteractionRecord = {
  readonly id: string
  readonly sessionID: string
  readonly sequence: number
  readonly createdAt: number
  readonly expiresAt?: number
  readonly deliveryCount: number
  readonly lastAck?: number
  readonly state: InteractionState
}

export function transition(record: InteractionRecord, event: "park" | "answer" | "cancel" | "expire", now = Date.now()): InteractionRecord {
  if (record.state === "answered" || record.state === "cancelled" || record.state === "expired") return record
  if (event === "park") return { ...record, state: "parked" }
  if (event === "answer") return { ...record, state: "answered", lastAck: now }
  if (event === "cancel") return { ...record, state: "cancelled", lastAck: now }
  return { ...record, state: "expired", lastAck: now }
}

export function deliver(record: InteractionRecord, now = Date.now()): InteractionRecord {
  if (record.state === "answered" || record.state === "cancelled" || record.state === "expired") return record
  return { ...record, deliveryCount: record.deliveryCount + 1, lastAck: record.lastAck ?? now }
}

export function reconcilePending(records: readonly InteractionRecord[], now = Date.now()) {
  return records.map((record) =>
    record.expiresAt !== undefined && record.expiresAt <= now && (record.state === "pending" || record.state === "parked")
      ? transition(record, "expire", now)
      : record,
  )
}
