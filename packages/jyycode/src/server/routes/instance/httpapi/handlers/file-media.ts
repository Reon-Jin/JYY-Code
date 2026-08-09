import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { parseFilePreviewRoute } from "@/server/shared/file-preview-routing"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { open, stat } from "node:fs/promises"
import path from "node:path"

const MAX_RANGE_BYTES = 4 * 1024 * 1024

export type FileByteRange = { start: number; end: number }

export function parseFileByteRange(value: string | undefined, size: number, maxBytes = MAX_RANGE_BYTES) {
  if (!value?.startsWith("bytes=") || size <= 0) return undefined
  const [range] = value.slice("bytes=".length).split(",", 1)
  const [startText, endText] = range?.split("-", 2) ?? []
  if (startText === undefined || endText === undefined) return undefined

  let start: number
  let end: number
  if (!startText) {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText ? Number(endText) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      return undefined
    }
    end = Math.min(end, size - 1)
  }

  return { start, end: Math.min(end, start + maxBytes - 1) }
}

function responseHeaders(file: string, size: number, modified: number) {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "content-type": AppFileSystem.mimeType(file),
    etag: `"${size}-${Math.trunc(modified)}"`,
  })
  return headers
}

const serve = Effect.fn("FileHttpApi.media")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const ctx = yield* InstanceState.context
  const url = new URL(request.url, "http://localhost")
  const filePreview = parseFilePreviewRoute(url)
  const requestedPath = filePreview?.filePath ?? url.searchParams.get("path") ?? ""
  const fullPath = path.resolve(ctx.directory, requestedPath)
  if (!containsPath(fullPath, ctx)) return HttpServerResponse.empty({ status: 403 })

  const metadata = yield* Effect.tryPromise({
    try: () => stat(fullPath),
    catch: () => new Error("File not found"),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!metadata?.isFile()) return HttpServerResponse.empty({ status: 404 })

  const headers = responseHeaders(fullPath, metadata.size, metadata.mtimeMs)
  if (filePreview) {
    headers.set("cache-control", "no-cache")
    headers.set("access-control-allow-origin", "*")
  }
  const etag = headers.get("etag")
  if (etag && request.headers["if-none-match"] === etag) {
    return HttpServerResponse.empty({ status: 304, headers })
  }

  const rangeHeader = request.headers.range
  const range = rangeHeader
    ? parseFileByteRange(rangeHeader, metadata.size)
    : filePreview
      ? { start: 0, end: Math.max(0, metadata.size - 1) }
      : { start: 0, end: Math.min(metadata.size - 1, MAX_RANGE_BYTES - 1) }
  if (!range) {
    headers.set("content-range", `bytes */${metadata.size}`)
    return HttpServerResponse.empty({ status: 416, headers })
  }

  const length = range.end - range.start + 1
  headers.set("content-length", String(length))
  if (!filePreview && (range.start !== 0 || range.end !== metadata.size - 1 || rangeHeader === undefined)) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${metadata.size}`)
  }
  if (request.method === "HEAD") return HttpServerResponse.empty({ status: 206, headers })

  const bytes = yield* Effect.tryPromise({
    try: async () => {
      const file = await open(fullPath, "r")
      try {
        const value = new Uint8Array(length)
        await file.read(value, 0, length, range.start)
        return value
      } finally {
        await file.close()
      }
    },
    catch: () => new Error("Unable to read file"),
  })
  return HttpServerResponse.raw(bytes, { status: filePreview && !rangeHeader ? 200 : 206, headers })
})

export const fileMediaRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/file/raw", serve)
    yield* router.add("GET", "/file/preview/*", serve)
  }),
)
