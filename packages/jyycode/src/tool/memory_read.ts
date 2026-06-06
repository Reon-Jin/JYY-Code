import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory_read.txt"
import { Memory } from "@/memory/memory"

export const Parameters = Schema.Struct({
  scope: Schema.Literals(["memory", "user"]).annotate({
    description: "Read D:/jyycode/memory/MEMORY.md with memory, or D:/jyycode/memory/USER.md with user preferences.",
  }),
  section: Schema.optional(Schema.String).annotate({
    description: "Optional section name, for example 'Engineering Conventions' or 'Communication Style'.",
  }),
})

export const MemoryReadTool = Tool.define(
  "memory_read",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "memory",
            patterns: [params.scope, params.section ?? "*"],
            always: ["*"],
            metadata: { scope: params.scope, section: params.section },
          })
          const output = yield* memory.read({ sessionID: ctx.sessionID, scope: params.scope, section: params.section })
          return {
            title: params.section ? `${params.scope}:${params.section}` : params.scope,
            metadata: { truncated: false },
            output: output || "No memory content found for that section.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
