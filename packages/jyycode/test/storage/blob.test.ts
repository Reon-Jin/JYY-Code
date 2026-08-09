import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BlobStore } from "../../src/storage/blob"
import { blobPath, parseDataURL } from "../../src/storage/blob-path"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-blob-"))
  roots.push(root)
  return new BlobStore(root)
}

describe("content-addressed blob store", () => {
  test("deduplicates identical streams and reads blob URLs", async () => {
    const blobs = await store()
    const source = Buffer.alloc(10 * 1024 * 1024, 7)
    const first = await blobs.putBytes(source, "image/png")
    const second = await blobs.putBytes(
      (async function* () {
        for (let offset = 0; offset < source.length; offset += 64 * 1024) {
          yield source.subarray(offset, Math.min(source.length, offset + 64 * 1024))
        }
      })() as AsyncIterable<Uint8Array>,
      "image/png",
    )

    expect(second.digest).toBe(first.digest)
    expect(await stat(blobPath(first.digest, blobs.root))).toBeDefined()
    expect(await blobs.readURL(first.url)).toEqual(source)
    const files = await readdir(path.join(blobs.root, "blob", "sha256", first.digest.slice(0, 2)))
    expect(files.filter((file) => file === first.digest)).toHaveLength(1)
  })

  test("keeps legacy data and file URLs readable", async () => {
    const blobs = await store()
    const data = parseDataURL(`data:image/png;base64,${Buffer.from("hello").toString("base64")}`)!
    expect(await blobs.readURL(`data:image/png;base64,${Buffer.from(data.bytes).toString("base64")}`)).toEqual(
      data.bytes,
    )
    const legacyFile = path.join(blobs.root, "legacy.png")
    await writeFile(legacyFile, data.bytes)
    expect(await blobs.readURL(pathToFileURL(legacyFile).href)).toEqual(data.bytes)
    const record = await blobs.putBytes(data.bytes, "image/png")
    expect(await blobs.toDataURL(record.url, "image/png")).toContain("aGVsbG8=")
  })

  test("externalizes binary file and tool attachments without expanding text data", async () => {
    const blobs = await store()
    const file = {
      id: PartID.make("prt_blob_file"),
      sessionID: SessionID.make("ses_blob"),
      messageID: MessageID.make("msg_blob"),
      type: "file" as const,
      mime: "image/png",
      url: `data:image/png;base64,${Buffer.from("pixels").toString("base64")}`,
    }
    const normalized = await blobs.normalizePart(file)
    expect(normalized.part.type).toBe("file")
    if (normalized.part.type === "file") expect(normalized.part.url).toMatch(/^blob:sha256:[a-f0-9]{64}$/)
    expect(normalized.records).toHaveLength(1)

    const text = { ...file, mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=" }
    const unchanged = await blobs.normalizePart(text)
    expect(unchanged.records).toHaveLength(0)
    expect(unchanged.part).toMatchObject({ url: text.url })
  })
})
