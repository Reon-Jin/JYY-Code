import { Effect, Semaphore } from "effect"
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { BlobRefTable, BlobTable } from "@/storage/blob.sql"
import { parseBlobURL } from "@/storage/blob-path"
import { PartTable } from "./session.sql"
import { Session } from "./session"
import type { SessionID } from "./schema"
import type { MessageV2 } from "./message-v2"

/** The model already uses at most the latest three computer observations. */
export const COMPUTER_SCREENSHOTS_TO_KEEP = 3
export const COMPUTER_SCREENSHOT_PRUNE_BATCH = 16
export const COMPUTER_SCREENSHOT_GLOBAL_BUDGET_BYTES = 512 * 1024 * 1024

// A shared lock prevents overlapping sweeps from rewriting the same tool part.
// Keep it process-wide rather than one semaphore per session, so idle sessions
// do not leave entries in a permanent lock map.
const sweepLock = Semaphore.makeUnsafe(1)

const completedComputer = sql<boolean>`json_extract(${PartTable.data}, '$.type') = 'tool'
  and json_extract(${PartTable.data}, '$.tool') = 'computer'
  and json_extract(${PartTable.data}, '$.state.status') = 'completed'`

const hasScreenshot = sql<boolean>`exists (
  select 1 from json_each(${PartTable.data}, '$.state.attachments') as attachment
  where json_extract(attachment.value, '$.mime') like 'image/%'
)`

const imageBlobReference = sql<boolean>`exists (
  select 1 from json_each(${PartTable.data}, '$.state.attachments') as attachment
  where json_extract(attachment.value, '$.mime') like 'image/%'
    and json_extract(attachment.value, '$.url') = 'blob:sha256:' || ${BlobRefTable.digest}
    and ${BlobRefTable.slot} = 'tool:' || attachment.key
)`

function isComputerResult(part: MessageV2.Part | undefined): part is MessageV2.ToolPart & {
  state: MessageV2.ToolStateCompleted
} {
  return part?.type === "tool" && part.tool === "computer" && part.state.status === "completed"
}

type Candidate = {
  id: typeof PartTable.$inferSelect.id
  messageID: typeof PartTable.$inferSelect.message_id
  sessionID: typeof PartTable.$inferSelect.session_id
}

const pruneOne = Effect.fn("ComputerScreenshotRetention.pruneOne")(function* (
  session: Session.Interface,
  row: Candidate,
  protectedIDs: ReadonlySet<string>,
) {
  const part = yield* session.getPart({
    sessionID: row.sessionID,
    messageID: row.messageID,
    partID: row.id,
  })
  if (!isComputerResult(part) || protectedIDs.has(part.id)) return { pruned: false, digests: [] as string[] }
  const removed = part.state.attachments?.filter((attachment) => attachment.mime.startsWith("image/")) ?? []
  if (!removed.length) return { pruned: false, digests: [] as string[] }
  const attachments = part.state.attachments?.filter((attachment) => !attachment.mime.startsWith("image/"))
  yield* session.updatePart({
    ...part,
    state: {
      ...part.state,
      attachments: attachments?.length ? attachments : undefined,
    },
  })
  return {
    pruned: true,
    digests: removed.map((attachment) => parseBlobURL(attachment.url)).filter((digest): digest is string => !!digest),
  }
})

const describeReleased = (digests: ReadonlySet<string>) => digests.size
  ? Database.query((db) => db.select({ digest: BlobTable.digest, bytes: BlobTable.size })
      .from(BlobTable).where(inArray(BlobTable.digest, [...digests])).all())
  : Effect.succeed([] as { digest: string; bytes: number }[])

const screenshotBytes = () => Database.query((db) => db
  .select({ bytes: sql<number>`coalesce(sum(${BlobTable.size}), 0)` })
  .from(BlobRefTable)
  .innerJoin(PartTable, eq(PartTable.id, BlobRefTable.part_id))
  .innerJoin(BlobTable, eq(BlobTable.digest, BlobRefTable.digest))
  .where(and(completedComputer, imageBlobReference))
  .get()).pipe(Effect.map((row) => row?.bytes ?? 0))

function batchLimit(value: number | undefined) {
  const requested = value ?? COMPUTER_SCREENSHOT_PRUNE_BATCH
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("Invalid computer screenshot prune batch size")
  return Math.min(64, requested)
}

/**
 * Release old computer screenshot references without changing the conversation
 * text or other tool attachments. Each invocation visits only a small batch;
 * callers may schedule another pass when `more` is true. Blob GC reclaims the
 * underlying files after these references have been removed.
 */
export const pruneComputerScreenshotAttachments = Effect.fn("ComputerScreenshotRetention.prune")(function* (input: {
  sessionID: SessionID
  batchSize?: number
}) {
  const session = yield* Session.Service
  const batchSize = batchLimit(input.batchSize)

  return yield* sweepLock.withPermit(Effect.gen(function* () {
    const newest = yield* Database.query((db) => db
      .select({ id: PartTable.id })
      .from(PartTable)
      .where(and(eq(PartTable.session_id, input.sessionID), completedComputer))
      .orderBy(desc(PartTable.time_created), desc(PartTable.id))
      .limit(COMPUTER_SCREENSHOTS_TO_KEEP)
      .all())
    if (newest.length < COMPUTER_SCREENSHOTS_TO_KEEP) return { pruned: 0, more: false, released: [] as {
      digest: string; bytes: number
    }[] }

    const protectedIDs = new Set(newest.map((item) => item.id))
    const candidates = yield* Database.query((db) => db
      .select({ id: PartTable.id, messageID: PartTable.message_id, sessionID: PartTable.session_id })
      .from(PartTable)
      .where(and(
        eq(PartTable.session_id, input.sessionID),
        completedComputer,
        hasScreenshot,
        notInArray(PartTable.id, [...protectedIDs]),
      ))
      .orderBy(PartTable.time_created, PartTable.id)
      .limit(batchSize + 1)
      .all())

    let pruned = 0
    const releasedDigests = new Set<string>()
    for (const row of candidates.slice(0, batchSize)) {
      const removed = yield* pruneOne(session, row, protectedIDs)
      if (removed.pruned) pruned++
      for (const digest of removed.digests) releasedDigests.add(digest)
    }
    const released = yield* describeReleased(releasedDigests)
    return { pruned, more: candidates.length > batchSize, released }
  }))
})

/**
 * Low-frequency cross-session budget sweep. The sum counts screenshot blob
 * references (an upper bound on physical blob bytes) and never counts uploads
 * or images from other tools. It may need several bounded passes to converge.
 */
export const enforceComputerScreenshotBudget = Effect.fn("ComputerScreenshotRetention.enforceBudget")(function* (input: {
  activeSessionID: SessionID
  budgetBytes?: number
  batchSize?: number
}) {
  const session = yield* Session.Service
  const budgetBytes = input.budgetBytes ?? COMPUTER_SCREENSHOT_GLOBAL_BUDGET_BYTES
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new Error("Invalid computer screenshot budget")
  const batchSize = batchLimit(input.batchSize)

  return yield* sweepLock.withPermit(Effect.gen(function* () {
    const beforeBytes = yield* screenshotBytes()
    if (beforeBytes <= budgetBytes) return {
      pruned: 0, more: false, released: [] as { digest: string; bytes: number }[],
      totalBytes: beforeBytes, budgetBytes, overBudget: false,
    }

    const newest = yield* Database.query((db) => db
      .select({ id: PartTable.id })
      .from(PartTable)
      .where(and(eq(PartTable.session_id, input.activeSessionID), completedComputer))
      .orderBy(desc(PartTable.time_created), desc(PartTable.id))
      .limit(COMPUTER_SCREENSHOTS_TO_KEEP)
      .all())
    const protectedIDs = new Set(newest.map((item) => item.id))
    const candidates = yield* Database.query((db) => db
      .select({
        id: PartTable.id,
        messageID: PartTable.message_id,
        sessionID: PartTable.session_id,
        bytes: sql<number>`sum(${BlobTable.size})`,
      })
      .from(BlobRefTable)
      .innerJoin(PartTable, eq(PartTable.id, BlobRefTable.part_id))
      .innerJoin(BlobTable, eq(BlobTable.digest, BlobRefTable.digest))
      .where(and(
        completedComputer,
        imageBlobReference,
        protectedIDs.size ? notInArray(PartTable.id, [...protectedIDs]) : undefined,
      ))
      .groupBy(PartTable.id)
      .orderBy(PartTable.time_created, PartTable.id)
      .limit(batchSize + 1)
      .all())

    let pruned = 0
    let projectedBytes = beforeBytes
    const releasedDigests = new Set<string>()
    for (const row of candidates.slice(0, batchSize)) {
      if (projectedBytes <= budgetBytes) break
      const removed = yield* pruneOne(session, row, protectedIDs)
      if (!removed.pruned) continue
      pruned++
      projectedBytes -= row.bytes
      for (const digest of removed.digests) releasedDigests.add(digest)
    }
    const [released, totalBytes] = yield* Effect.all([describeReleased(releasedDigests), screenshotBytes()])
    const overBudget = totalBytes > budgetBytes
    return {
      pruned,
      more: overBudget && candidates.length > batchSize,
      released,
      totalBytes,
      budgetBytes,
      overBudget,
    }
  }))
})
