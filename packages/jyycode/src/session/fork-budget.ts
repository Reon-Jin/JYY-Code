import crypto from "node:crypto"
import { parseDataURL } from "@/storage/blob-path"
import type { MessageV2 } from "./message-v2"

export const FORK_BUDGET_HARD_LIMITS = {
  maxLogicalBytes: 20 * 1024 * 1024,
  maxPartCount: 10_000,
  maxPhysicalBlobBytes: 20 * 1024 * 1024,
} as const

export type ForkBudget = {
  readonly maxLogicalBytes?: number
  readonly maxPartCount?: number
  readonly maxPhysicalBlobBytes?: number
}

export type ForkEstimate = {
  readonly messageCount: number
  readonly partCount: number
  readonly logicalBytes: number
  readonly physicalBlobBytesAdded: number
  readonly allowed: boolean
  readonly reasons: readonly ("logical-bytes" | "part-count" | "physical-blob-bytes")[]
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8")
}

function dataDigest(url: string) {
  const parsed = parseDataURL(url)
  return parsed ? crypto.createHash("sha256").update(parsed.bytes).digest("hex") : undefined
}

export function estimateFork(messages: readonly MessageV2.WithParts[], budget: ForkBudget = {}): ForkEstimate {
  const maxLogicalBytes = Math.min(
    FORK_BUDGET_HARD_LIMITS.maxLogicalBytes,
    Math.max(1, Math.floor(budget.maxLogicalBytes ?? FORK_BUDGET_HARD_LIMITS.maxLogicalBytes)),
  )
  const maxPartCount = Math.min(
    FORK_BUDGET_HARD_LIMITS.maxPartCount,
    Math.max(1, Math.floor(budget.maxPartCount ?? FORK_BUDGET_HARD_LIMITS.maxPartCount)),
  )
  const maxPhysicalBlobBytes = Math.min(
    FORK_BUDGET_HARD_LIMITS.maxPhysicalBlobBytes,
    Math.max(1, Math.floor(budget.maxPhysicalBlobBytes ?? FORK_BUDGET_HARD_LIMITS.maxPhysicalBlobBytes)),
  )
  const seenData = new Set<string>()
  let logicalBytes = 0
  let partCount = 0
  let physicalBlobBytesAdded = 0
  for (const message of messages) {
    logicalBytes += jsonBytes(message.info)
    for (const part of message.parts) {
      partCount++
      logicalBytes += jsonBytes(part)
      const attachments =
        part.type === "file"
          ? [part]
          : part.type === "tool" && part.state.status === "completed"
            ? (part.state.attachments ?? [])
            : []
      for (const attachment of attachments) {
        const parsed = parseDataURL(attachment.url)
        const digest = dataDigest(attachment.url)
        if (!parsed || !digest || seenData.has(digest)) continue
        seenData.add(digest)
        physicalBlobBytesAdded += parsed.bytes.byteLength
      }
    }
  }
  const reasons = [
    ...(logicalBytes > maxLogicalBytes ? (["logical-bytes"] as const) : []),
    ...(partCount > maxPartCount ? (["part-count"] as const) : []),
    ...(physicalBlobBytesAdded > maxPhysicalBlobBytes ? (["physical-blob-bytes"] as const) : []),
  ]
  return {
    messageCount: messages.length,
    partCount,
    logicalBytes,
    physicalBlobBytesAdded,
    allowed: reasons.length === 0,
    reasons,
  }
}

export class ForkBudgetError extends Error {
  readonly code = "FORK_BUDGET_EXCEEDED"

  constructor(readonly estimate: ForkEstimate) {
    super(`session fork exceeds bounded storage budget: ${estimate.reasons.join(", ")}`)
    this.name = "ForkBudgetError"
  }
}
