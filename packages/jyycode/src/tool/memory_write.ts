import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory_write.txt"
import { Memory } from "@/memory/memory"

const Scope = Schema.Literals(["memory", "user"])
const Confidence = Schema.Literals(["low", "medium", "high"])

export const Parameters = Schema.Struct({
  scope: Scope.annotate({ description: "Write to MEMORY.md for project memory, or USER.md for user memory." }),
  section: Schema.String.annotate({ description: "Target markdown section name." }),
  content: Schema.String.annotate({ description: "Durable memory content to store." }),
  reason: Schema.String.annotate({ description: "Why this should be remembered long term." }),
  confidence: Schema.optional(Confidence).annotate({ description: "Confidence in this memory. Defaults to medium." }),
  source: Schema.optional(Schema.String).annotate({ description: "Optional source label. Defaults to current session." }),
})

export const MemoryWriteTool = Tool.define(
  "memory_write",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "memory",
            patterns: [params.scope, params.section],
            always: ["*"],
            metadata: { action: "write", ...params },
          })
          const result = yield* memory.write({
            sessionID: ctx.sessionID,
            scope: params.scope,
            section: params.section,
            content: params.content,
            reason: params.reason,
            confidence: params.confidence,
            source: params.source ?? `session:${ctx.sessionID}`,
          })
          return {
            title: "Memory write",
            metadata: { id: result.id, status: result.status, truncated: false },
            output: result.message,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
