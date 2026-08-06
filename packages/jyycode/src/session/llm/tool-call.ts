/**
 * Distinguish a tool call whose JSON arguments were cut off mid-stream
 * (output-token limit, dropped connection, early stream end) from a genuinely
 * malformed call. The AI SDK repair callback uses this so the model receives a
 * truncation-specific recovery message instead of a generic "invalid
 * arguments" error that makes it retry the same oversized call.
 */

const TRUNCATION_ERROR_PATTERNS = [
  /unexpected end of (?:json )?input/i,
  /unterminated string/i,
  /unexpected end of input/i,
  /unterminated (?:string|array|object|literal)/i,
]

export function isTruncatedToolCall(rawInput: string | undefined, error: unknown): boolean {
  const input = rawInput ?? ""

  // Structural check: an unterminated string or an unclosed object/array at
  // the end of the input is the signature of a stream cut off mid-JSON.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{" || ch === "[") depth++
    else if (ch === "}" || ch === "]") depth--
  }
  if (depth > 0 || inString) return true

  const message = error instanceof Error ? error.message : String(error)
  return TRUNCATION_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}
