import crypto from "node:crypto"

export const MAX_SESSION_ROW_BYTES = 16 * 1024 * 1024

export type CorruptSessionRow = {
  readonly table: "message" | "part"
  readonly id: string
  readonly digest: string
  readonly size: number
  readonly reason: "oversized" | "invalid-json" | "schema-invalid"
}

export type DecodedSessionRow<T> = { readonly value: T } | { readonly error: CorruptSessionRow }

export function decodeStoredJSONRow<T>(input: {
  readonly table: CorruptSessionRow["table"]
  readonly id: string
  readonly data: unknown
  readonly decode: (value: unknown) => T
  readonly maxBytes?: number
}): DecodedSessionRow<T> {
  const text = typeof input.data === "string" ? input.data : JSON.stringify(input.data)
  const source = text ?? "null"
  const size = Buffer.byteLength(source, "utf8")
  const digest = crypto.createHash("sha256").update(source).digest("hex")
  if (size > (input.maxBytes ?? MAX_SESSION_ROW_BYTES)) {
    return { error: { table: input.table, id: input.id, digest, size, reason: "oversized" } }
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return { error: { table: input.table, id: input.id, digest, size, reason: "invalid-json" } }
  }
  try {
    return { value: input.decode(value) }
  } catch {
    return { error: { table: input.table, id: input.id, digest, size, reason: "schema-invalid" } }
  }
}

export function isDecoded<T>(result: DecodedSessionRow<T>): result is { readonly value: T } {
  return "value" in result
}
