import { Context, Effect, Layer } from "effect"
import { Global } from "@jyycode-ai/core/global"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { BlobRefTable, BlobTable } from "./blob.sql"
import {
  blobPath,
  blobTempPath,
  blobURL,
  isBlobDigest,
  parseBlobURL,
  parseDataURL,
  parseFileURL,
} from "./blob-path"
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import type { MessageV2 } from "@/session/message-v2"

export const DEFAULT_MAX_BLOB_BYTES = 50 * 1024 * 1024
export const BLOB_GRACE_MS = 24 * 60 * 60 * 1000

export class BlobLimitError extends Error {
  readonly code = "BLOB_SIZE_LIMIT"

  constructor(readonly limit: number, readonly actual: number) {
    super(`Blob exceeds ${limit} bytes (received at least ${actual})`)
    this.name = "BlobLimitError"
  }
}

export class BlobIntegrityError extends Error {
  readonly code = "BLOB_INTEGRITY_ERROR"

  constructor(message: string) {
    super(message)
    this.name = "BlobIntegrityError"
  }
}

export type BlobSource = Uint8Array | ArrayBuffer | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>

export type BlobRecord = {
  readonly digest: string
  readonly size: number
  readonly mime: string
  readonly createdAt: number
  readonly verifiedAt: number
  readonly path: string
  readonly url: string
}

export type BlobDescriptor = {
  readonly digest: string
  readonly size: number
  readonly mime: string
}

export type PutInput = {
  readonly source: BlobSource
  readonly mime: string
  readonly maxBytes?: number
  readonly persistMetadata?: boolean
}

async function* sourceChunks(source: BlobSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source
    return
  }
  if (source instanceof ArrayBuffer) {
    yield new Uint8Array(source)
    return
  }
  if (typeof ReadableStream !== "undefined" && source instanceof ReadableStream) {
    const reader = source.getReader()
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        if (next.value) yield next.value
      }
    } finally {
      reader.releaseLock()
    }
    return
  }
  for await (const chunk of source as AsyncIterable<Uint8Array>) yield chunk
}

async function digestFile(file: string) {
  const hash = crypto.createHash("sha256")
  let size = 0
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null)
      if (result.bytesRead === 0) break
      size += result.bytesRead
      hash.update(buffer.subarray(0, result.bytesRead))
    }
  } finally {
    await handle.close()
  }
  return { size, digest: hash.digest("hex") }
}

function isTextMime(mime: string) {
  const value = mime.toLowerCase()
  return value.startsWith("text/") || value === "application/json" || value === "application/xml"
}

export class BlobStore {
  readonly root: string

  constructor(root = Global.Path.data) {
    this.root = path.resolve(root)
  }

  async put(input: PutInput): Promise<BlobRecord> {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BLOB_BYTES
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer")
    const tempRoot = path.dirname(blobTempPath("placeholder", this.root))
    await mkdir(tempRoot, { recursive: true })
    const temp = blobTempPath(`${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.part`, this.root)
    const handle = await open(temp, "wx")
    const hash = crypto.createHash("sha256")
    let size = 0
    try {
      for await (const chunk of sourceChunks(input.source)) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        size += bytes.byteLength
        if (size > maxBytes) throw new BlobLimitError(maxBytes, size)
        hash.update(bytes)
        await handle.write(bytes)
      }
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    await handle.sync()
    await handle.close()

    const digest = hash.digest("hex")
    if (!isBlobDigest(digest)) throw new BlobIntegrityError("sha256 digest was not canonical")
    const destination = blobPath(digest, this.root)
    await mkdir(path.dirname(destination), { recursive: true })

    try {
      const existing = await stat(destination).catch(() => undefined)
      if (existing) {
        const existingDigest = await digestFile(destination)
        if (existingDigest.digest !== digest || existingDigest.size !== size) {
          const quarantine = `${destination}.quarantine-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
          await rename(destination, quarantine)
        }
      }
      const afterQuarantine = await stat(destination).catch(() => undefined)
      if (!afterQuarantine) {
        await rename(temp, destination)
      } else {
        await rm(temp, { force: true })
      }
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }

    const now = Date.now()
    const record: BlobRecord = {
      digest,
      size,
      mime: input.mime || "application/octet-stream",
      createdAt: now,
      verifiedAt: now,
      path: destination,
      url: blobURL(digest),
    }
    if (input.persistMetadata) await this.persistMetadata(record)
    return record
  }

  async putBytes(source: BlobSource, mime: string, options?: Omit<PutInput, "source" | "mime">) {
    return this.put({ source, mime, ...options })
  }

  async readURL(url: string): Promise<Uint8Array> {
    const digest = parseBlobURL(url)
    if (digest) return new Uint8Array(await readFile(blobPath(digest, this.root)))
    const data = parseDataURL(url)
    if (data) return data.bytes
    const file = parseFileURL(url)
    if (file) return new Uint8Array(await readFile(path.resolve(file)))
    throw new BlobIntegrityError(`Unsupported attachment URL: ${url.slice(0, 80)}`)
  }

  async toDataURL(url: string, mime: string) {
    return `data:${mime};base64,${Buffer.from(await this.readURL(url)).toString("base64")}`
  }

  async describeURL(url: string, mime: string): Promise<BlobDescriptor> {
    const data = parseDataURL(url)
    if (data) {
      return {
        digest: crypto.createHash("sha256").update(data.bytes).digest("hex"),
        size: data.bytes.byteLength,
        mime,
      }
    }
    const blobDigest = parseBlobURL(url)
    if (blobDigest) {
      const verified = await digestFile(blobPath(blobDigest, this.root))
      if (verified.digest !== blobDigest) throw new BlobIntegrityError(`Blob digest mismatch for ${blobDigest}`)
      return { digest: blobDigest, size: verified.size, mime }
    }
    const file = parseFileURL(url)
    if (file) {
      const verified = await digestFile(path.resolve(file))
      return { digest: verified.digest, size: verified.size, mime }
    }
    throw new BlobIntegrityError(`Unsupported attachment URL: ${url.slice(0, 80)}`)
  }

  async persistMetadata(record: BlobRecord) {
    await Effect.runPromise(this.persistMetadataEffect(record))
  }

  async attachReference(input: { partID: string; slot: string; record: BlobRecord }) {
    await Effect.runPromise(this.attachReferenceEffect(input))
  }

  persistMetadataEffect(record: BlobRecord): Effect.Effect<void, never, never> {
    return Database.withTransaction((db) =>
      db
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
          set: {
            size: record.size,
            mime: record.mime,
            verified_at: record.verifiedAt,
            last_ref_removed_at: null,
          },
        })
        .run(),
    ) as Effect.Effect<void, never, never>
  }

  attachReferenceEffect(input: { partID: string; slot: string; record: BlobRecord }): Effect.Effect<void, never, never> {
    const metadata = this.persistMetadataEffect(input.record)
    const reference = Database.withTransaction((db) =>
      db
        .insert(BlobRefTable)
        .values({
          part_id: input.partID,
          slot: input.slot,
          digest: input.record.digest,
          created_at: Date.now(),
        })
        .onConflictDoUpdate({
          target: [BlobRefTable.part_id, BlobRefTable.slot],
          set: { digest: input.record.digest },
        })
        .run(),
    ) as Effect.Effect<void, never, never>
    return Effect.gen(function* () {
      yield* metadata
      yield* reference
    })
  }

  syncReferencesEffect(
    partID: string,
    references: readonly { slot: string; record: BlobRecord }[],
  ): Effect.Effect<void, never, never> {
    return Database.withTransaction((db) =>
      Effect.gen(function* () {
        const previous = yield* db
          .select({ digest: BlobRefTable.digest })
          .from(BlobRefTable)
          .where(eq(BlobRefTable.part_id, partID))
          .all()
        yield* db.delete(BlobRefTable).where(eq(BlobRefTable.part_id, partID)).run()
        const removedAt = Date.now()
        for (const item of previous) {
          yield* db
            .update(BlobTable)
            .set({ last_ref_removed_at: removedAt })
            .where(eq(BlobTable.digest, item.digest))
            .run()
        }
        for (const { slot, record } of references) {
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
              set: {
                size: record.size,
                mime: record.mime,
                verified_at: record.verifiedAt,
                last_ref_removed_at: null,
              },
            })
            .run()
          yield* db
            .insert(BlobRefTable)
            .values({ part_id: partID, slot, digest: record.digest, created_at: Date.now() })
            .onConflictDoUpdate({
              target: [BlobRefTable.part_id, BlobRefTable.slot],
              set: { digest: record.digest },
            })
            .run()
        }
      }),
    ) as Effect.Effect<void, never, never>
  }

  private async recordForBlob(digest: string, mime: string): Promise<BlobRecord> {
    const file = blobPath(digest, this.root)
    const verified = await digestFile(file)
    if (verified.digest !== digest) throw new BlobIntegrityError(`Blob digest mismatch for ${digest}`)
    const now = Date.now()
    return {
      digest,
      size: verified.size,
      mime: mime || "application/octet-stream",
      createdAt: now,
      verifiedAt: now,
      path: file,
      url: blobURL(digest),
    }
  }

  async normalizePart(part: MessageV2.Part): Promise<{ part: MessageV2.Part; records: BlobRecord[] }> {
    const records: BlobRecord[] = []
    const normalize = async (file: MessageV2.FilePart) => {
      const data = parseDataURL(file.url)
      if (data && isTextMime(file.mime)) return file
      if (data) {
        const record = await this.putBytes(data.bytes, file.mime)
        records.push(record)
        return { ...file, url: record.url }
      }
      const digest = parseBlobURL(file.url)
      if (digest) {
        const record = await this.recordForBlob(digest, file.mime)
        records.push(record)
        return file
      }
      const filePath = parseFileURL(file.url)
      if (!filePath) return file
      const record = await this.putBytes(new Uint8Array(await readFile(path.resolve(filePath))), file.mime)
      records.push(record)
      return { ...file, url: record.url }
    }
    if (part.type === "file") return { part: await normalize(part), records }
    if (part.type !== "tool" || part.state.status !== "completed" || !part.state.attachments?.length)
      return { part, records }
    const attachments: MessageV2.FilePart[] = []
    for (const attachment of part.state.attachments) attachments.push(await normalize(attachment))
    return { part: { ...part, state: { ...part.state, attachments } }, records }
  }
}

export interface Interface {
  readonly put: (input: PutInput) => Effect.Effect<BlobRecord>
  readonly readURL: (url: string) => Effect.Effect<Uint8Array>
  readonly toDataURL: (url: string, mime: string) => Effect.Effect<string>
  readonly normalizePart: (part: MessageV2.Part) => Effect.Effect<{ part: MessageV2.Part; records: BlobRecord[] }>
  readonly attachPart: (part: MessageV2.Part, records: readonly BlobRecord[]) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/BlobStore") {}

export function makeService(root = Global.Path.data): Interface {
  const store = new BlobStore(root)
  return Service.of({
    put: (input) => Effect.tryPromise(() => store.put(input)),
    readURL: (url) => Effect.tryPromise(() => store.readURL(url)),
    toDataURL: (url, mime) => Effect.tryPromise(() => store.toDataURL(url, mime)),
    normalizePart: (part) => Effect.tryPromise(() => store.normalizePart(part)),
    attachPart: (part, records) =>
      Effect.gen(function* () {
        const references: Array<{ slot: string; record: BlobRecord }> = []
        if (part.type === "file") {
          const digest = parseBlobURL(part.url)
          const record = digest ? records.find((item) => item.digest === digest) : undefined
          if (record) references.push({ slot: "file", record })
        } else if (part.type === "tool" && part.state.status === "completed") {
          for (const [index, attachment] of (part.state.attachments ?? []).entries()) {
            const digest = parseBlobURL(attachment.url)
            const record = digest ? records.find((item) => item.digest === digest) : undefined
            if (record) references.push({ slot: `tool:${index}`, record })
          }
        }
        yield* store.syncReferencesEffect(part.id, references)
      }),
  })
}

export const layer = (root?: string) => Layer.succeed(Service, makeService(root))
export const defaultLayer = layer()
