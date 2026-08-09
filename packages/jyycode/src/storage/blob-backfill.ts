import { Effect } from "effect"
import { and, asc, eq, gt, lte } from "drizzle-orm"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { BlobStore } from "./blob"
import { BlobRefTable, BlobTable } from "./blob.sql"
import { blobURL, parseDataURL } from "./blob-path"
import { Database } from "@/storage/db"
import { PartTable } from "@/session/session.sql"
import type { MessageV2 } from "@/session/message-v2"
import type { PartID } from "@/session/schema"

export const BLOB_BACKFILL_DEFAULTS = {
  batchSize: 100,
  batchBytes: 64 * 1024 * 1024,
  batchTimeoutMs: 30_000,
} as const

type Cursor = {
  version: 1
  watermark: number
  lastPartID: string | null
  completed: boolean
  updatedAt: number
}

export type BlobBackfillOptions = {
  readonly root?: string
  readonly dryRun?: boolean
  readonly watermark?: number
  readonly batchSize?: number
  readonly batchBytes?: number
  readonly batchTimeoutMs?: number
  readonly maxBatches?: number
  readonly cursorPath?: string
  readonly reset?: boolean
  readonly now?: () => number
}

export type BlobBackfillReport = {
  readonly root: string
  readonly cursorPath: string
  readonly dryRun: boolean
  readonly watermark: number
  readonly scanned: number
  readonly candidates: number
  readonly migrated: number
  readonly skipped: number
  readonly concurrent: number
  readonly corrupt: number
  readonly bytes: number
  readonly completed: boolean
  readonly lastPartID: string | null
}

type Attachment = {
  readonly slot: string
  readonly mime: string
  readonly bytes: Uint8Array
}

type PreparedPart = {
  readonly data: unknown
  readonly attachments: readonly Attachment[]
  readonly bytes: number
}

function positive(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback
}

function cursorFile(root: string, value?: string) {
  return path.resolve(value ?? path.join(root, ".jyycode", "storage", "blob-backfill.cursor.json"))
}

async function loadCursor(file: string): Promise<Cursor | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Cursor>
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.watermark) ||
      (parsed.lastPartID !== null && typeof parsed.lastPartID !== "string") ||
      typeof parsed.completed !== "boolean"
    )
      return undefined
    return {
      version: 1,
      watermark: parsed.watermark as number,
      lastPartID: parsed.lastPartID ?? null,
      completed: parsed.completed,
      updatedAt: Number.isSafeInteger(parsed.updatedAt) ? parsed.updatedAt! : Date.now(),
    }
  } catch {
    return undefined
  }
}

async function saveCursor(file: string, cursor: Cursor) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(cursor, null, 2), { mode: 0o600 })
  try {
    await rename(temporary, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error
    await rm(file, { force: true })
    await rename(temporary, file)
  }
}

function parseBackfillDataURL(value: string) {
  if (!value.startsWith("data:")) return undefined
  const comma = value.indexOf(",")
  const encoded = comma >= 0 ? value.slice(comma + 1) : ""
  if (!comma || !encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error("malformed base64 data URL")
  const parsed = parseDataURL(value)
  if (!parsed) throw new Error("unsupported data URL")
  return parsed
}

function preparePart(data: unknown): PreparedPart {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("part data is not an object")
  const part = data as Record<string, any>
  const attachments: Attachment[] = []
  const visit = (value: unknown, slot: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${slot} attachment is invalid`)
    const file = value as Record<string, unknown>
    if (typeof file.url !== "string" || typeof file.mime !== "string") throw new Error(`${slot} attachment is malformed`)
    const parsed = parseBackfillDataURL(file.url)
    if (parsed) attachments.push({ slot, mime: file.mime, bytes: parsed.bytes })
    return parsed
  }

  if (part.type === "file") {
    visit(part, "file")
  } else if (part.type === "tool" && part.state?.status === "completed") {
    if (part.state.attachments !== undefined && !Array.isArray(part.state.attachments))
      throw new Error("tool attachments are not an array")
    for (const [index, attachment] of (part.state.attachments ?? []).entries()) visit(attachment, `tool:${index}`)
  }

  return {
    data,
    attachments,
    bytes: attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0),
  }
}

function replaceURLs(data: unknown, records: readonly { slot: string; url: string }[]) {
  if (!records.length) return data
  const replacement = new Map(records.map((record) => [record.slot, record.url]))
  const part = structuredClone(data) as Record<string, any>
  if (part.type === "file" && replacement.has("file")) part.url = replacement.get("file")
  if (part.type === "tool" && part.state?.status === "completed") {
    for (const [index, attachment] of (part.state.attachments ?? []).entries()) {
      const url = replacement.get(`tool:${index}`)
      if (url) attachment.url = url
    }
  }
  return part
}

function sameData(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

export function runBlobBackfill(options: BlobBackfillOptions = {}): Effect.Effect<BlobBackfillReport> {
  const root = path.resolve(options.root ?? process.env.JYYCODE_DATA_DIR ?? process.cwd())
  const cursorPath = cursorFile(root, options.cursorPath)
  const dryRun = options.dryRun !== false
  const batchSize = positive(options.batchSize, BLOB_BACKFILL_DEFAULTS.batchSize)
  const maxBatchBytes = positive(options.batchBytes, BLOB_BACKFILL_DEFAULTS.batchBytes)
  const batchTimeoutMs = positive(options.batchTimeoutMs, BLOB_BACKFILL_DEFAULTS.batchTimeoutMs)
  const now = options.now ?? Date.now

  return Effect.gen(function* () {
    const existing = options.reset ? undefined : yield* Effect.promise(() => loadCursor(cursorPath))
    const watermark = existing?.watermark ?? options.watermark ?? now()
    let lastPartID = existing?.lastPartID ?? null
    let completed = existing?.completed ?? false
    let scanned = 0
    let candidates = 0
    let migrated = 0
    let skipped = 0
    let concurrent = 0
    let corrupt = 0
    let bytes = 0
    let batches = 0

    if (completed && !options.reset) {
      return {
        root,
        cursorPath,
        dryRun,
        watermark,
        scanned,
        candidates,
        migrated,
        skipped,
        concurrent,
        corrupt,
        bytes,
        completed: true,
        lastPartID,
      }
    }

    const store = new BlobStore(root)
    while (true) {
      if (options.maxBatches !== undefined && batches >= options.maxBatches) break
      const conditions = [lte(PartTable.time_updated, watermark)]
      if (lastPartID) conditions.push(gt(PartTable.id, lastPartID as PartID))
      const rows = yield* Database.query((db) =>
        db
          .select()
          .from(PartTable)
          .where(and(...conditions))
          .orderBy(asc(PartTable.id))
          .limit(batchSize)
          .all(),
      )
      if (!rows.length) {
        completed = true
        break
      }

      const batchStarted = now()
      let processed = 0
      let usedBatchBytes = 0
      let batchLastPartID = lastPartID
      for (const row of rows) {
        if (processed > 0 && now() - batchStarted >= batchTimeoutMs) break
        let prepared: PreparedPart
        try {
          prepared = preparePart(row.data)
        } catch {
          scanned++
          corrupt++
          batchLastPartID = row.id
          processed++
          continue
        }
        if (prepared.attachments.length && processed > 0 && usedBatchBytes + prepared.bytes > maxBatchBytes) break
        if (prepared.attachments.length && prepared.bytes > maxBatchBytes) {
          scanned++
          candidates++
          corrupt++
          bytes += prepared.bytes
          batchLastPartID = row.id
          processed++
          continue
        }

        scanned++
        batchLastPartID = row.id
        processed++
        if (!prepared.attachments.length) {
          skipped++
          continue
        }
        candidates++
        bytes += prepared.bytes
        usedBatchBytes += prepared.bytes
        if (dryRun) continue

        const records: Array<{ slot: string; url: string; digest: string; size: number; mime: string; createdAt: number; verifiedAt: number }> = []
        for (const attachment of prepared.attachments) {
          const record = yield* Effect.promise(() => store.putBytes(attachment.bytes, attachment.mime))
          records.push({
            slot: attachment.slot,
            url: blobURL(record.digest),
            digest: record.digest,
            size: record.size,
            mime: record.mime,
            createdAt: record.createdAt,
            verifiedAt: record.verifiedAt,
          })
        }

        const normalized = replaceURLs(prepared.data, records)
        const result = yield* Database.withTransaction((db) =>
          Effect.gen(function* () {
            const current = yield* db
              .select()
              .from(PartTable)
              .where(and(eq(PartTable.id, row.id), lte(PartTable.time_updated, watermark)))
              .get()
            if (!current || !sameData(current.data, row.data)) return "concurrent" as const
            for (const record of records) {
              yield* db
                .insert(BlobTable)
                .values({
                  digest: record.digest,
                  size: record.size,
                  mime: record.mime,
                  created_at: record.createdAt,
                  verified_at: record.verifiedAt,
                  last_ref_removed_at: null,
                })
                .onConflictDoUpdate({
                  target: BlobTable.digest,
                  set: { size: record.size, mime: record.mime, verified_at: record.verifiedAt, last_ref_removed_at: null },
                })
                .run()
              yield* db
                .insert(BlobRefTable)
                .values({ part_id: row.id, slot: record.slot, digest: record.digest, created_at: now() })
                .onConflictDoUpdate({ target: [BlobRefTable.part_id, BlobRefTable.slot], set: { digest: record.digest } })
                .run()
            }
            yield* db.update(PartTable).set({ data: normalized as MessageV2.Part }).where(eq(PartTable.id, row.id)).run()
            return "migrated" as const
          }),
        )
        if (result === "migrated") migrated++
        else concurrent++
      }

      if (processed === 0) break
      lastPartID = batchLastPartID
      batches++
      if (!dryRun) {
        yield* Effect.promise(() =>
          saveCursor(cursorPath, { version: 1, watermark, lastPartID, completed: false, updatedAt: now() }),
        )
      }
      if (processed < rows.length) continue
    }

    if (!dryRun && completed) {
      yield* Effect.promise(() =>
        saveCursor(cursorPath, { version: 1, watermark, lastPartID, completed: true, updatedAt: now() }),
      )
    }
    return {
      root,
      cursorPath,
      dryRun,
      watermark,
      scanned,
      candidates,
      migrated,
      skipped,
      concurrent,
      corrupt,
      bytes,
      completed,
      lastPartID,
    }
  })
}

export function runBlobBackfillNow(options: BlobBackfillOptions = {}) {
  return Effect.runPromise(runBlobBackfill(options))
}
