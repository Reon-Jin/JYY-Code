import crypto from "node:crypto"
import { asc, eq } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { PlanActivationTable } from "./activation.sql"
import { defaultPlanEventStore, type PlanEventStore } from "./event-store"

export const DEFAULT_PLAN_ACTIVATION_LEASE_TTL_MS = 30_000
const processInstanceId = crypto.randomUUID()

export type PlanActivationState = "starting" | "running" | "draining" | "settled"

export type PlanActivation = {
  session_id: string
  parent_session_id: string
  task_id: string
  run_id: string
  owner_id: string
  generation: number
  lease_expires_at: number
  state: PlanActivationState
  recovery_reason?: string
  time_created: number
  time_updated: number
}

export type PlanActivationView = {
  durable: PlanActivation
  live: boolean
}

export class PlanActivationError extends Error {
  constructor(
    message: string,
    readonly code: "OWNED" | "STALE_GENERATION" | "NOT_FOUND" | "NOT_EXPIRED" | "SETTLED",
  ) {
    super(message)
    this.name = "PlanActivationError"
  }
}

export type PlanActivationStoreOptions = {
  leaseTtlMs?: number
  now?: () => number
  events?: PlanEventStore
}

export type PlanActivationClaimInput = {
  session_id: string
  parent_session_id: string
  task_id: string
  run_id: string
  owner_id: string
  leaseTtlMs?: number
  now?: number
}

export type PlanActivationCasInput = {
  session_id: string
  owner_id: string
  generation: number
  now?: number
}

export type PlanActivationTransitionInput = PlanActivationCasInput & {
  state: PlanActivationState
  leaseTtlMs?: number
}

function ensureSchema(db: Database.TxOrDb) {
  db.run(
    sql.raw(
      "CREATE TABLE IF NOT EXISTS plan_activation (session_id TEXT PRIMARY KEY NOT NULL, parent_session_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL, owner_id TEXT NOT NULL, generation INTEGER NOT NULL, lease_expires_at INTEGER NOT NULL, state TEXT NOT NULL, recovery_reason TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
    ),
  )
  db.run(
    sql.raw("CREATE INDEX IF NOT EXISTS plan_activation_parent_idx ON plan_activation(parent_session_id, session_id)"),
  )
  db.run(sql.raw("CREATE INDEX IF NOT EXISTS plan_activation_lease_idx ON plan_activation(lease_expires_at, state)"))
  db.run(sql.raw("CREATE INDEX IF NOT EXISTS plan_activation_owner_idx ON plan_activation(owner_id, state)"))
}

function toActivation(row: typeof PlanActivationTable.$inferSelect): PlanActivation {
  return {
    session_id: row.session_id,
    parent_session_id: row.parent_session_id,
    task_id: row.task_id,
    run_id: row.run_id,
    owner_id: row.owner_id,
    generation: row.generation,
    lease_expires_at: row.lease_expires_at,
    state: row.state as PlanActivationState,
    ...(row.recovery_reason === null ? {} : { recovery_reason: row.recovery_reason }),
    time_created: row.time_created,
    time_updated: row.time_updated,
  }
}

function isExpired(activation: PlanActivation, now: number) {
  return activation.lease_expires_at <= now
}

export class PlanActivationStore {
  private readonly leaseTtlMs: number
  private readonly now: () => number
  private readonly events: PlanEventStore

  constructor(options: PlanActivationStoreOptions = {}) {
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_PLAN_ACTIVATION_LEASE_TTL_MS
    this.now = options.now ?? Date.now
    this.events = options.events ?? defaultPlanEventStore
  }

  get(session_id: string) {
    return Database.legacyQuery((db) => {
      ensureSchema(db)
      const row = db.select().from(PlanActivationTable).where(eq(PlanActivationTable.session_id, session_id)).get()
      return row ? toActivation(row) : undefined
    })
  }

  claim(input: PlanActivationClaimInput) {
    const now = input.now ?? this.now()
    const ttl = input.leaseTtlMs ?? this.leaseTtlMs
    const result = Database.legacyTransaction(
      (db) => {
        ensureSchema(db)
        const existingRow = db
          .select()
          .from(PlanActivationTable)
          .where(eq(PlanActivationTable.session_id, input.session_id))
          .get()
        const existing = existingRow ? toActivation(existingRow) : undefined
        if (!existing) {
          const activation: PlanActivation = {
            session_id: input.session_id,
            parent_session_id: input.parent_session_id,
            task_id: input.task_id,
            run_id: input.run_id,
            owner_id: input.owner_id,
            generation: 1,
            lease_expires_at: now + ttl,
            state: "starting",
            time_created: now,
            time_updated: now,
          }
          db.insert(PlanActivationTable)
            .values({ ...activation, recovery_reason: null })
            .run()
          return { activation, takeover: undefined as { previous_owner_id: string } | undefined }
        }
        if (existing.owner_id !== input.owner_id && !isExpired(existing, now) && existing.state !== "settled")
          throw new PlanActivationError("activation is owned by another live process", "OWNED")
        if (existing.owner_id === input.owner_id && existing.state !== "settled") {
          db.update(PlanActivationTable)
            .set({
              parent_session_id: input.parent_session_id,
              task_id: input.task_id,
              run_id: input.run_id,
              state: "starting" as const,
              recovery_reason: null,
              lease_expires_at: now + ttl,
              time_updated: now,
            })
            .where(eq(PlanActivationTable.session_id, input.session_id))
            .run()
          return {
            activation: {
              ...existing,
              parent_session_id: input.parent_session_id,
              task_id: input.task_id,
              run_id: input.run_id,
              state: "starting" as const,
              recovery_reason: undefined,
              lease_expires_at: now + ttl,
              time_updated: now,
            },
            takeover: undefined as { previous_owner_id: string } | undefined,
          }
        }
        const activation: PlanActivation = {
          ...existing,
          parent_session_id: input.parent_session_id,
          task_id: input.task_id,
          run_id: input.run_id,
          owner_id: input.owner_id,
          generation: existing.generation + 1,
          lease_expires_at: now + ttl,
          state: "starting",
          recovery_reason: "expired_activation_claim",
          time_updated: now,
        }
        db.update(PlanActivationTable)
          .set({
            parent_session_id: activation.parent_session_id,
            task_id: activation.task_id,
            run_id: activation.run_id,
            owner_id: activation.owner_id,
            generation: activation.generation,
            lease_expires_at: activation.lease_expires_at,
            state: activation.state,
            recovery_reason: activation.recovery_reason,
            time_updated: activation.time_updated,
          })
          .where(eq(PlanActivationTable.session_id, input.session_id))
          .run()
        return { activation, takeover: { previous_owner_id: existing.owner_id } }
      },
      { behavior: "immediate" },
    )
    if (result.takeover)
      this.emitRecovery(result.activation, result.takeover.previous_owner_id, result.activation.recovery_reason)
    return result.activation
  }

  renew(input: PlanActivationCasInput & { leaseTtlMs?: number }) {
    const now = input.now ?? this.now()
    const ttl = input.leaseTtlMs ?? this.leaseTtlMs
    return Database.legacyTransaction(
      (db) => {
        const current = this.readForUpdate(db, input.session_id)
        this.assertCas(current, input)
        if (current.state === "settled") throw new PlanActivationError("activation is already settled", "SETTLED")
        const lease_expires_at = now + ttl
        db.update(PlanActivationTable)
          .set({ lease_expires_at, time_updated: now })
          .where(eq(PlanActivationTable.session_id, input.session_id))
          .run()
        return { ...current, lease_expires_at, time_updated: now }
      },
      { behavior: "immediate" },
    )
  }

  transition(input: PlanActivationTransitionInput) {
    const now = input.now ?? this.now()
    const ttl = input.leaseTtlMs ?? this.leaseTtlMs
    return Database.legacyTransaction(
      (db) => {
        const current = this.readForUpdate(db, input.session_id)
        this.assertCas(current, input)
        if (current.state === "settled" && input.state !== "settled")
          throw new PlanActivationError("activation is already settled", "SETTLED")
        const lease_expires_at = input.state === "settled" ? current.lease_expires_at : now + ttl
        db.update(PlanActivationTable)
          .set({ state: input.state, lease_expires_at, time_updated: now })
          .where(eq(PlanActivationTable.session_id, input.session_id))
          .run()
        return { ...current, state: input.state, lease_expires_at, time_updated: now }
      },
      { behavior: "immediate" },
    )
  }

  settle(input: PlanActivationCasInput) {
    return this.transition({ ...input, state: "settled" })
  }

  takeover(input: { session_id: string; owner_id: string; leaseTtlMs?: number; now?: number; reason?: string }) {
    const now = input.now ?? this.now()
    const ttl = input.leaseTtlMs ?? this.leaseTtlMs
    const result = Database.legacyTransaction(
      (db) => {
        const current = this.readForUpdate(db, input.session_id)
        if (!current) throw new PlanActivationError("activation not found", "NOT_FOUND")
        if (!isExpired(current, now) && current.state !== "settled")
          throw new PlanActivationError("activation lease has not expired", "NOT_EXPIRED")
        const activation: PlanActivation = {
          ...current,
          owner_id: input.owner_id,
          generation: current.generation + 1,
          lease_expires_at: now + ttl,
          state: "starting",
          recovery_reason: input.reason ?? "owner_lease_expired",
          time_updated: now,
        }
        db.update(PlanActivationTable)
          .set({
            owner_id: activation.owner_id,
            generation: activation.generation,
            lease_expires_at: activation.lease_expires_at,
            state: activation.state,
            recovery_reason: activation.recovery_reason,
            time_updated: activation.time_updated,
          })
          .where(eq(PlanActivationTable.session_id, input.session_id))
          .run()
        return { activation, previous_owner_id: current.owner_id }
      },
      { behavior: "immediate" },
    )
    this.emitRecovery(result.activation, result.previous_owner_id, result.activation.recovery_reason)
    return result.activation
  }

  list(options: { now?: number; isOwnerLive?: (ownerId: string) => boolean } = {}) {
    const now = options.now ?? this.now()
    const isOwnerLive = options.isOwnerLive ?? (() => false)
    return Database.legacyQuery((db) => {
      ensureSchema(db)
      return db
        .select()
        .from(PlanActivationTable)
        .orderBy(asc(PlanActivationTable.time_created))
        .all()
        .map((row) => {
          const durable = toActivation(row)
          return {
            durable,
            live: durable.state !== "settled" && durable.lease_expires_at > now && isOwnerLive(durable.owner_id),
          }
        })
    })
  }

  remove(session_id: string) {
    return Database.legacyTransaction(
      (db) => {
        ensureSchema(db)
        db.delete(PlanActivationTable).where(eq(PlanActivationTable.session_id, session_id)).run()
      },
      { behavior: "immediate" },
    )
  }

  private readForUpdate(db: Database.TxOrDb, session_id: string) {
    ensureSchema(db)
    const row = db.select().from(PlanActivationTable).where(eq(PlanActivationTable.session_id, session_id)).get()
    return row ? toActivation(row) : undefined
  }

  private assertCas(
    current: PlanActivation | undefined,
    input: PlanActivationCasInput,
  ): asserts current is PlanActivation {
    if (!current) throw new PlanActivationError("activation not found", "NOT_FOUND")
    if (current.owner_id !== input.owner_id || current.generation !== input.generation)
      throw new PlanActivationError("stale activation generation or owner", "STALE_GENERATION")
  }

  private emitRecovery(activation: PlanActivation, previous_owner_id: string, reason = "owner_lease_expired") {
    this.events.append({
      type: "child.recovery",
      session_id: activation.parent_session_id,
      payload: {
        kind: "activation_takeover",
        child_session_id: activation.session_id,
        previous_owner_id,
        owner_id: activation.owner_id,
        generation: activation.generation,
        reason,
      },
      at: new Date(activation.time_updated).toISOString(),
    })
  }
}

export const defaultPlanActivationStore = new PlanActivationStore()

export function activationOwnerId() {
  return `process:${process.pid}:${processInstanceId}`
}

export * as PlanActivation from "./activation"
