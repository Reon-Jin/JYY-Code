import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { BlobStore } from "../../src/storage/blob"
import { blobPath, blobRoot } from "../../src/storage/blob-path"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("quarantines an existing digest collision and never overwrites it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-blob-crash-"))
  roots.push(root)
  const store = new BlobStore(root)
  const content = Buffer.from("correct bytes")
  const digest = crypto.createHash("sha256").update(content).digest("hex")
  const destination = blobPath(digest, root)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, Buffer.from("wrong bytes"))

  const record = await store.putBytes(content, "application/octet-stream")
  expect(record.digest).toBe(digest)
  expect(await readFile(destination)).toEqual(content)
  const siblings = await readdir(path.dirname(destination))
  expect(siblings.some((name) => name.startsWith(`${digest}.quarantine-`))).toBe(true)
})

test("removes a partial temporary file when the input exceeds the hard limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-blob-limit-"))
  roots.push(root)
  const store = new BlobStore(root)
  await expect(store.putBytes(Buffer.alloc(32), "application/octet-stream", { maxBytes: 16 })).rejects.toMatchObject({
    code: "BLOB_SIZE_LIMIT",
  })
  expect(await readdir(blobRoot(root).concat("/.tmp").replaceAll("/", path.sep))).toHaveLength(0)
})
