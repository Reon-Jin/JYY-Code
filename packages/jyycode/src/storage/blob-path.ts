import { Global } from "@jyycode-ai/core/global"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const BLOB_SCHEME = "blob:sha256:"
export const BLOB_ROOT_NAME = "blob"
export const BLOB_ALGORITHM = "sha256"
export const BLOB_DIGEST_LENGTH = 64

export function blobRoot(dataRoot = Global.Path.data) {
  return path.join(path.resolve(dataRoot), BLOB_ROOT_NAME, BLOB_ALGORITHM)
}

export function isBlobDigest(value: string): value is string {
  return /^[a-f0-9]{64}$/.test(value)
}

export function blobURL(digest: string) {
  if (!isBlobDigest(digest)) throw new Error(`Invalid blob digest: ${digest}`)
  return `${BLOB_SCHEME}${digest}`
}

export function parseBlobURL(value: string): string | undefined {
  const digest = value.startsWith(BLOB_SCHEME) ? value.slice(BLOB_SCHEME.length) : undefined
  return digest && isBlobDigest(digest) ? digest : undefined
}

export function blobPath(digest: string, dataRoot = Global.Path.data) {
  if (!isBlobDigest(digest)) throw new Error(`Invalid blob digest: ${digest}`)
  return path.join(blobRoot(dataRoot), digest.slice(0, 2), digest)
}

export function blobTempRoot(dataRoot = Global.Path.data) {
  return path.join(blobRoot(dataRoot), ".tmp")
}

export function blobTempPath(name: string, dataRoot = Global.Path.data) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Invalid blob temporary file name")
  return path.join(blobTempRoot(dataRoot), name)
}

export function blobLeasePath(digest: string, dataRoot = Global.Path.data) {
  if (!isBlobDigest(digest)) throw new Error(`Invalid blob digest: ${digest}`)
  return blobTempPath(`${digest}.lease`, dataRoot)
}

export function parseDataURL(value: string): { mime: string; bytes: Uint8Array } | undefined {
  const match = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s)
  if (!match) return undefined
  return { mime: match[1]!, bytes: Buffer.from(match[2]!, "base64") }
}

export function parseFileURL(value: string): string | undefined {
  if (!value.startsWith("file:")) return undefined
  return fileURLToPath(value)
}
