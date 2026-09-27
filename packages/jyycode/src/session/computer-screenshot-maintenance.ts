import { Cause, Context, Effect } from "effect"
import * as Log from "@jyycode-ai/core/util/log"
import { desc, eq, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { BlobRefTable, BlobTable } from "@/storage/blob.sql"
import { PartTable } from "./session.sql"
import { Session } from "./session"
import type { SessionID } from "./schema"
import { enforceComputerScreenshotBudget, pruneComputerScreenshotAttachments } from "./computer-screenshot-retention"
import { collectReleasedComputerScreenshots } from "./computer-screenshot-gc"

const log = Log.create({ service: "computer-screenshot-maintenance" })

/** Group screenshot maintenance across actions without delaying tool results. */
export const COMPUTER_SCREENSHOT_MAINTENANCE_DELAY_MS = 5_000
export const COMPUTER_SCREENSHOT_MAINTENANCE_ACTIONS = 16
const RETRY_DELAY_MS = 5_000
const MAX_SESSIONS_PER_PASS = 4

type Work = {
  sessionID: SessionID
  context: Context.Context<Session.Service>
}

type Released = { digest: string; bytes: number }
type SweepResult = { more: boolean; released: Released[] }

type SchedulerOptions = {
  delayMs?: number
  actionThreshold?: number
  prune?: (work: Work) => Promise<SweepResult>
  budget?: (work: Work) => Promise<SweepResult>
  collect?: (released: Released[], work: Work) => Promise<void>
}

export class ComputerScreenshotMaintenanceScheduler {
  private readonly pending = new Map<SessionID, Work>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private deadline = Infinity
  private current: Promise<void> | undefined
  private actionsSinceBudget = 0
  private firstBudgetCheck = true
  private budgetRetry: Work | undefined
  private latestWork: Work | undefined

  private readonly delayMs: number
  private readonly actionThreshold: number
  private readonly prune: NonNullable<SchedulerOptions["prune"]>
  private readonly budget: NonNullable<SchedulerOptions["budget"]>
  private readonly collect: NonNullable<SchedulerOptions["collect"]>

  constructor(options: SchedulerOptions = {}) {
    this.delayMs = options.delayMs ?? COMPUTER_SCREENSHOT_MAINTENANCE_DELAY_MS
    this.actionThreshold = options.actionThreshold ?? COMPUTER_SCREENSHOT_MAINTENANCE_ACTIONS
    if (!Number.isSafeInteger(this.delayMs) || this.delayMs < 0 ||
      !Number.isSafeInteger(this.actionThreshold) || this.actionThreshold < 1)
      throw new Error("Invalid screenshot maintenance schedule")
    this.prune = options.prune ?? ((work) => Effect.runPromise(pruneComputerScreenshotAttachments({
      sessionID: work.sessionID,
    }).pipe(Effect.provide(work.context))))
    this.budget = options.budget ?? ((work) => Effect.runPromise(enforceComputerScreenshotBudget({
      activeSessionID: work.sessionID,
      batchSize: 32,
    }).pipe(Effect.provide(work.context))))
    this.collect = options.collect ?? ((released, work) => Effect.runPromise(
      collectReleasedComputerScreenshots(released).pipe(Effect.provide(work.context)),
    ))
  }

  enqueue(work: Work) {
    this.pending.set(work.sessionID, work)
    this.latestWork = work
    this.actionsSinceBudget++
    this.schedule(this.actionsSinceBudget >= this.actionThreshold ? 0 : this.delayMs)
  }

  requestBudget(work: Work) {
    this.latestWork = work
    this.budgetRetry = work
    this.schedule(this.delayMs)
  }

  private schedule(delayMs: number) {
    const deadline = Date.now() + delayMs
    if (this.timer && this.deadline <= deadline) return
    if (this.timer) clearTimeout(this.timer)
    this.deadline = deadline
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.deadline = Infinity
      void this.flush()
    }, delayMs)
    this.timer.unref?.()
  }

  /** Exposed for deterministic shutdown/tests; ordinary actions only enqueue. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.deadline = Infinity
    if (this.current) return this.current
    this.current = this.runPass().finally(() => {
      this.current = undefined
      if (this.pending.size || this.budgetRetry) this.schedule(RETRY_DELAY_MS)
    })
    return this.current
  }

  private async runPass() {
    const work = [...this.pending.values()].slice(0, MAX_SESSIONS_PER_PASS)
    for (const item of work) this.pending.delete(item.sessionID)
    const checkBudget = this.firstBudgetCheck ||
      this.actionsSinceBudget >= this.actionThreshold || !!this.budgetRetry
    if (checkBudget) {
      this.firstBudgetCheck = false
      this.actionsSinceBudget = 0
    }

    const released: Released[] = []
    for (const item of work) {
      try {
        const result = await this.prune(item)
        released.push(...result.released)
        if (result.more && !this.pending.has(item.sessionID)) this.pending.set(item.sessionID, item)
      } catch (error) {
        log.warn("computer screenshot retention deferred", { error: Cause.pretty(Cause.fail(error)) })
      }
    }

    const active = this.latestWork ?? work.at(-1) ?? this.budgetRetry
    if (checkBudget && active) {
      try {
        const result = await this.budget(active)
        released.push(...result.released)
        this.budgetRetry = result.more ? active : undefined
      } catch (error) {
        this.budgetRetry = undefined
        log.warn("computer screenshot budget cleanup deferred", { error: Cause.pretty(Cause.fail(error)) })
      }
    }

    if (!released.length || !active) return
    try {
      await this.collect(released, active)
    } catch (error) {
      log.warn("computer screenshot file cleanup deferred", { error: Cause.pretty(Cause.fail(error)) })
    }
  }
}

const scheduler = new ComputerScreenshotMaintenanceScheduler()

/** Enqueue maintenance in constant time; no database query or file deletion is awaited by the action. */
export const scheduleComputerScreenshotMaintenance = Effect.fn("ComputerScreenshotMaintenance.schedule")(function* (
  input: { sessionID: SessionID },
) {
  const context = yield* Effect.context<Session.Service>()
  scheduler.enqueue({ sessionID: input.sessionID, context })
})

/** Once after server startup, revisit sessions left untrimmed by a prior exit. */
export const scheduleStartupComputerScreenshotMaintenance = Effect.fn(
  "ComputerScreenshotMaintenance.scheduleStartup",
)(function* () {
  const context = yield* Effect.context<Session.Service>()
  const rows = yield* Database.query((db) => db
    .select({
      sessionID: PartTable.session_id,
      screenshots: sql<number>`count(distinct ${PartTable.id})`,
      latest: sql<number>`max(${PartTable.time_created})`,
    })
    .from(BlobRefTable)
    .crossJoin(PartTable)
    .innerJoin(BlobTable, eq(BlobTable.digest, BlobRefTable.digest))
    .where(sql`${PartTable.id} = ${BlobRefTable.part_id}
      and json_extract(${PartTable.data}, '$.type') = 'tool'
      and json_extract(${PartTable.data}, '$.tool') = 'computer'
      and json_extract(${PartTable.data}, '$.state.status') = 'completed'
      and ${BlobRefTable.slot} like 'tool:%'
      and ${BlobTable.mime} like 'image/%'`)
    .groupBy(PartTable.session_id)
    .orderBy(desc(sql`max(${PartTable.time_created})`))
    .all())
  for (const row of rows) {
    if (row.screenshots <= 3) continue
    scheduler.enqueue({ sessionID: row.sessionID, context })
  }
  const latest = rows[0]
  if (latest) scheduler.requestBudget({ sessionID: latest.sessionID, context })
  return { sessions: rows.length, queued: rows.filter((row) => row.screenshots > 3).length }
})

export const flushComputerScreenshotMaintenance = () => scheduler.flush()
