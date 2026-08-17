import { Effect, Schema, Stream } from "effect"

export const ContentLimits = {
  webResponseBytes: 5 * 1024 * 1024,
  localAttachmentBytes: 20 * 1024 * 1024,
  mcpAttachmentBytes: 5 * 1024 * 1024,
} as const

export class ContentLimitError extends Schema.TaggedErrorClass<ContentLimitError>()("ContentLimitError", {
  resource: Schema.String,
  limit: Schema.Number,
  actual: Schema.Number,
}) {
  override get message() {
    return `${this.resource} exceeds the ${this.limit}-byte content limit (received at least ${this.actual} bytes)`
  }
}

export const readBoundedBytes = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number,
  resource: string,
): Effect.Effect<Uint8Array, E | ContentLimitError, R> =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = []
    let total = 0

    yield* stream.pipe(
      Stream.runForEach((chunk) => {
        const next = total + chunk.byteLength
        if (next > limit) {
          return Effect.fail(
            new ContentLimitError({
              resource,
              limit,
              actual: Math.min(next, limit + 1),
            }),
          )
        }

        chunks.push(chunk)
        total = next
        return Effect.void
      }),
    )

    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  })

export function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

export function ensureBase64WithinLimit(
  value: string,
  limit: number,
  resource: string,
): Effect.Effect<void, ContentLimitError> {
  const actual = base64ByteLength(value)
  return actual > limit ? Effect.fail(new ContentLimitError({ resource, limit, actual })) : Effect.void
}
