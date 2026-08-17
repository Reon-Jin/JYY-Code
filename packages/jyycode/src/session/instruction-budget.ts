import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Token } from "@/util/token"

export const DEFAULT_INSTRUCTION_FILE_BYTES = 256 * 1024
export const DEFAULT_INSTRUCTION_TOKENS = 16_000
export const DEFAULT_INSTRUCTION_SAFETY_MARGIN = 0.1

export type InstructionCandidate = {
  readonly source: string
  readonly content: string
  readonly bytes: number
  readonly digest: string
  readonly required?: boolean
}

export type InstructionBudgetOptions = {
  readonly maxFileBytes?: number
  readonly maxTokens?: number
  readonly safetyMargin?: number
  readonly excerptBytes?: number
}

export type InstructionEntry = InstructionCandidate & {
  readonly included: boolean
  readonly oversized: boolean
  readonly includedRange?: { readonly start: number; readonly end: number }
  readonly omittedReason?: "file_bytes" | "total_tokens"
}

export class InstructionBudgetError extends Error {
  readonly code = "INSTRUCTION_BUDGET_EXCEEDED"
  readonly entry: InstructionEntry

  constructor(entry: InstructionEntry) {
    super(`required instruction exceeds budget: ${entry.source} (${entry.bytes} bytes, ${entry.digest})`)
    this.name = "InstructionBudgetError"
    this.entry = entry
  }
}

export type InstructionBudgetResult = {
  readonly entries: readonly InstructionEntry[]
  readonly tokens: number
}

function safeLimit(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${name} must be a positive finite number`)
  return result
}

export function budgetInstructions(
  candidates: readonly InstructionCandidate[],
  options: InstructionBudgetOptions = {},
): InstructionBudgetResult {
  const maxFileBytes = safeLimit(options.maxFileBytes, DEFAULT_INSTRUCTION_FILE_BYTES, "maxFileBytes")
  const maxTokens = safeLimit(options.maxTokens, DEFAULT_INSTRUCTION_TOKENS, "maxTokens")
  const safetyMargin = options.safetyMargin ?? DEFAULT_INSTRUCTION_SAFETY_MARGIN
  if (!Number.isFinite(safetyMargin) || safetyMargin < 0 || safetyMargin >= 1)
    throw new Error("invalid instruction safety margin")
  const excerptBytes = Math.min(maxFileBytes, Math.max(1, options.excerptBytes ?? 4096))
  const entries: InstructionEntry[] = []
  let tokens = 0
  const available = Math.floor(maxTokens * (1 - safetyMargin))

  for (const candidate of candidates) {
    const oversized = candidate.bytes > maxFileBytes
    const excerpt = candidate.content.slice(0, excerptBytes)
    const manifest = `[Instruction omitted: source=${candidate.source}; digest=${candidate.digest}; bytes=${candidate.bytes}; included_range=0:${Buffer.byteLength(excerpt, "utf8")}]`
    const fullText = `Instructions from: ${candidate.source}\n${candidate.content}`
    const excerptText = `Instructions from: ${candidate.source}\n${manifest}\n${excerpt}`
    const fullTokens = Token.estimate(fullText)
    const excerptTokens = Token.estimate(excerptText)
    const required = candidate.required === true

    if (oversized && required) {
      const entry: InstructionEntry = {
        ...candidate,
        included: false,
        oversized: true,
        omittedReason: "file_bytes",
      }
      throw new InstructionBudgetError(entry)
    }

    if (!oversized && tokens + fullTokens <= available) {
      entries.push({
        ...candidate,
        included: true,
        oversized: false,
        includedRange: { start: 0, end: candidate.bytes },
      })
      tokens += fullTokens
      continue
    }

    if (!required && tokens + excerptTokens <= available) {
      entries.push({
        ...candidate,
        content: `${manifest}\n${excerpt}`,
        included: true,
        oversized,
        includedRange: { start: 0, end: Buffer.byteLength(excerpt, "utf8") },
        omittedReason: oversized ? "file_bytes" : "total_tokens",
      })
      tokens += excerptTokens
      continue
    }

    const entry: InstructionEntry = {
      ...candidate,
      included: false,
      oversized,
      omittedReason: oversized ? "file_bytes" : "total_tokens",
    }
    if (required) throw new InstructionBudgetError(entry)
    entries.push(entry)
  }

  return { entries, tokens }
}

export type BoundedRead = {
  readonly content: string
  readonly bytes: number
  readonly digest: string
  readonly mtimeMs?: number
  readonly size?: number
}

export async function readFileBounded(
  filepath: string,
  maxRetainedBytes = DEFAULT_INSTRUCTION_FILE_BYTES,
): Promise<BoundedRead> {
  const info = await stat(filepath)
  const hash = createHash("sha256")
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of createReadStream(filepath, { highWaterMark: 32 * 1024 })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hash.update(buffer)
    bytes += buffer.byteLength
    const remaining = maxRetainedBytes - chunks.reduce((total, item) => total + item.byteLength, 0)
    if (remaining > 0) chunks.push(buffer.subarray(0, remaining))
  }
  return {
    content: Buffer.concat(chunks).toString("utf8"),
    bytes,
    digest: hash.digest("hex"),
    mtimeMs: info.mtimeMs,
    size: info.size,
  }
}

export function remoteReadBounded(
  chunks: readonly Uint8Array[],
  maxRetainedBytes = DEFAULT_INSTRUCTION_FILE_BYTES,
): BoundedRead {
  const hash = createHash("sha256")
  const retained: Uint8Array[] = []
  let bytes = 0
  let retainedBytes = 0
  for (const chunk of chunks) {
    hash.update(chunk)
    bytes += chunk.byteLength
    const remaining = maxRetainedBytes - retainedBytes
    if (remaining > 0) {
      const next = chunk.subarray(0, remaining)
      retained.push(next)
      retainedBytes += next.byteLength
    }
  }
  return {
    content: Buffer.concat(retained.map((item) => Buffer.from(item))).toString("utf8"),
    bytes,
    digest: hash.digest("hex"),
  }
}
