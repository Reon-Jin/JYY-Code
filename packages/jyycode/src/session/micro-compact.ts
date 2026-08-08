export const DEFAULT_MICRO_COMPACT_MAX_CHARS = 8_000

const MARKER_PREFIX = "[micro-compacted:"

type RecordLike = Record<string, unknown>

function record(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null
}

function outputOf(part: unknown): string | undefined {
  if (!record(part) || part.type !== "tool" || !record(part.state)) return undefined
  if (part.state.status !== "completed" || typeof part.state.output !== "string") return undefined
  return part.state.output
}

function takeHead(text: string, budget: number) {
  const raw = text.slice(0, budget)
  const boundary = raw.lastIndexOf("\n")
  if (boundary >= Math.max(1, Math.floor(raw.length / 2))) return raw.slice(0, boundary)
  const nextBoundary = text.indexOf("\n", budget)
  if (nextBoundary !== -1 && nextBoundary <= budget * 2) return text.slice(0, nextBoundary)
  return raw
}

function takeTail(text: string, budget: number) {
  const start = Math.max(0, text.length - budget)
  const raw = text.slice(start)
  const boundary = raw.indexOf("\n")
  const previousBoundary = text.lastIndexOf("\n", start - 1)
  if (boundary >= 0 && boundary <= Math.floor(raw.length / 2)) {
    if (previousBoundary !== -1 && text.length - previousBoundary - 1 <= budget * 3) {
      return text.slice(previousBoundary + 1)
    }
    return raw.slice(boundary + 1)
  }
  if (previousBoundary !== -1 && text.length - previousBoundary - 1 <= budget * 3) {
    return text.slice(previousBoundary + 1)
  }
  return raw
}

export function isCompactable(part: unknown): boolean {
  return outputOf(part) !== undefined
}

export function microCompactOutput(
  output: string,
  maxChars = DEFAULT_MICRO_COMPACT_MAX_CHARS,
): { content: string } | null {
  if (maxChars <= 0 || output.length <= maxChars || output.includes(MARKER_PREFIX)) return null

  const headBudget = Math.max(1, Math.floor(maxChars * 0.4))
  const tailBudget = Math.max(1, Math.floor(maxChars * 0.4))
  if (headBudget + tailBudget >= output.length) return null

  const head = takeHead(output, headBudget)
  const tail = takeTail(output, tailBudget)
  const hidden = output.length - head.length - tail.length
  if (hidden <= 0) return null

  const marker = `${MARKER_PREFIX} original ${output.length} chars; hidden ${hidden} chars]`
  const content = [head, marker, tail].join("\n")
  if (content.length >= output.length) return null
  return { content }
}

export function estimateMicroCompactSavings(
  messages: readonly unknown[],
  maxChars = DEFAULT_MICRO_COMPACT_MAX_CHARS,
): number {
  let savings = 0
  for (const message of messages) {
    if (!record(message) || !Array.isArray(message.parts)) continue
    for (const part of message.parts) {
      const output = outputOf(part)
      if (output === undefined) continue
      const compacted = microCompactOutput(output, maxChars)
      if (compacted) savings += output.length - compacted.content.length
    }
  }
  return savings
}
