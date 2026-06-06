import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory_supersede.txt"
import { Memory } from "@/memory/memory"

const Replacement = Schema.Struct({
  section: Schema.String,
  content: Schema.String,
  confidence: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  source: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})

export const Parameters = Schema.Struct({
  scope: Schema.Literals(["memory", "user"]).annotate({ description: "File containing the old memory id." }),
  id: Schema.String.annotate({ description: "Memory entry id to supersede." }),
  reason: Schema.String.annotate({ description: "Why this memory is no longer current." }),
  replacement: Schema.optional(Replacement).annotate({
    description: "Optional replacement memory to write before superseding the old entry.",
  }),
})

export const MemorySupersedeTool = Tool.define(
  "memory_supersede",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "memory",
            patterns: [params.scope, params.id],
            always: ["*"],
            metadata: { action: "supersede", ...params },
          })
          const result = yield* memory.supersede({ sessionID: ctx.sessionID, ...params })
          return {
            title: "Memory supersede",
            metadata: { id: result.id, status: result.status, truncated: false },
            output: result.message,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
