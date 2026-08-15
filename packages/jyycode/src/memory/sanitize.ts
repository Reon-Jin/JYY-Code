export type SanitizedText = {
  text: string
  redacted: number
  /** Alias useful to telemetry callers; neither field contains source text. */
  redactionCount: number
}

const REDACTED = "[REDACTED]"
const REDACTED_CONNECTION = "[REDACTED_CONNECTION_STRING]"

const patterns: readonly RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu,
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp|sqlserver):\/\/[^\s<>"']+/giu,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:basic|bearer|token)\s+[^\s,;]+/giu,
  /\b(?:x-api-key|api[-_ ]?key|access[-_ ]?key|secret|password|passwd|token|cookie|client[-_ ]?secret)\s*[:=]\s*[^\s,;]+/giu,
  /\b(?:bearer|basic)\s+[A-Za-z0-9+/_=-]{12,}/giu,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/gu,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
]

/**
 * Redact secrets before durable storage or prompt injection. The replacement is
 * intentionally fixed-width and audit callers should use only the count.
 */
export function sanitizeForPersistence(input: string): SanitizedText {
  let text = input
  let redacted = 0
  for (const pattern of patterns) {
    text = text.replace(pattern, () => {
      redacted++
      return pattern.source.includes("postgres") || pattern.source.includes("mysql") ? REDACTED_CONNECTION : REDACTED
    })
  }
  return { text, redacted, redactionCount: redacted }
}

export function looksSensitive(input: string): boolean {
  return sanitizeForPersistence(input).redacted > 0
}

export function sanitizeRecord<T extends Record<string, unknown>>(record: T): { record: T; redacted: number } {
  let redacted = 0
  const next = { ...record } as T
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") continue
    const sanitized = sanitizeForPersistence(value)
    ;(next as Record<string, unknown>)[key] = sanitized.text
    redacted += sanitized.redacted
  }
  return { record: next, redacted }
}
