import { createHash } from "node:crypto"

export const DEFAULT_MCP_STDERR_WINDOW_MS = 60_000
export const DEFAULT_MCP_STDERR_MAX_BYTES = 64 * 1024
export const DEFAULT_MCP_STDERR_CHUNK_BYTES = 4 * 1024

export interface StderrPolicyOptions {
  readonly server?: string
  readonly windowMs?: number
  readonly maxBytesPerWindow?: number
  readonly maxChunkBytes?: number
  readonly now?: () => number
  readonly homePath?: string
}

export interface StderrReport {
  readonly server?: string
  readonly acceptedBytes: number
  readonly droppedBytes: number
  readonly windowBytes: number
  readonly chunkBytes: number
  readonly digest: string
  readonly redacted: boolean
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function redactHomePath(value: string, homePath?: string) {
  let result = value
  if (homePath) result = result.replace(new RegExp(escapeRegExp(homePath), "gi"), "<home>")
  result = result
    .replace(/([A-Za-z]:[\\/]+Users[\\/])[^\\/\s"']+/gi, "$1<user>")
    .replace(/(\/Users\/)[^/\s"']+/g, "$1<user>")
    .replace(/(\/home\/)[^/\s"']+/g, "$1<user>")
  return result
}

/** Redact common credentials and local profile paths before anything is logged. */
export function sanitizeStderr(value: string, homePath?: string) {
  let result = value
  result = result.replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1<redacted>")
  result = result.replace(/((?:x-)?api[-_ ]?key\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
  result = result.replace(/(cookie\s*:\s*)[^\r\n]+/gi, "$1<redacted>")
  result = result.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted>")
  result = redactHomePath(result, homePath)
  return result
}

export class MCPStderrPolicy {
  readonly server?: string
  readonly windowMs: number
  readonly maxBytesPerWindow: number
  readonly maxChunkBytes: number

  private readonly now: () => number
  private readonly homePath?: string
  private windowStartedAt: number
  private windowBytes = 0

  constructor(options: StderrPolicyOptions = {}) {
    this.server = options.server
    this.windowMs = Math.max(1, Math.floor(options.windowMs ?? DEFAULT_MCP_STDERR_WINDOW_MS))
    this.maxBytesPerWindow = Math.max(1, Math.floor(options.maxBytesPerWindow ?? DEFAULT_MCP_STDERR_MAX_BYTES))
    this.maxChunkBytes = Math.max(1, Math.floor(options.maxChunkBytes ?? DEFAULT_MCP_STDERR_CHUNK_BYTES))
    this.now = options.now ?? Date.now
    this.homePath = options.homePath
    this.windowStartedAt = this.now()
  }

  push(chunk: string | Uint8Array): StderrReport {
    const now = this.now()
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now
      this.windowBytes = 0
    }

    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength
    const acceptedBytes = Math.min(bytes, this.maxChunkBytes, Math.max(0, this.maxBytesPerWindow - this.windowBytes))
    const droppedBytes = bytes - acceptedBytes
    const sample =
      typeof chunk === "string"
        ? Buffer.from(chunk).subarray(0, acceptedBytes)
        : Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, acceptedBytes))
    const sanitized = sanitizeStderr(sample.toString("utf8"), this.homePath)
    const digest = createHash("sha256").update(sanitized).digest("hex")
    this.windowBytes += acceptedBytes

    return {
      ...(this.server ? { server: this.server } : {}),
      acceptedBytes,
      droppedBytes,
      windowBytes: this.windowBytes,
      chunkBytes: Math.min(bytes, this.maxChunkBytes),
      digest,
      redacted: sanitized !== sample.toString("utf8"),
    }
  }

  reset(now = this.now()) {
    this.windowStartedAt = now
    this.windowBytes = 0
  }
}

export function createStderrPolicy(options: StderrPolicyOptions = {}) {
  return new MCPStderrPolicy(options)
}

export * as StderrPolicy from "./stderr-policy"
