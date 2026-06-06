import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory_patch.txt"
import { Memory } from "@/memory/memory"

export const Parameters = Schema.Struct({
  scope: Schema.Literals(["memory", "user"]).annotate({ description: "File containing the memory id." }),
  id: Schema.String.annotate({ description: "Memory entry id to patch." }),
  content: Schema.String.annotate({ description: "Replacement durable memory content." }),
  reason: Schema.String.annotate({ description: "Why this memory is being corrected." }),
})

export const MemoryPatchTool = Tool.define(
  "memory_patch",
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
            metadata: { action: "patch", ...params },
          })
          const result = yield* memory.patch({ sessionID: ctx.sessionID, ...params })
          return {
            title: "Memory patch",
            metadata: { id: result.id, file: result.file, status: result.status, truncated: false },
            output: result.message,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
