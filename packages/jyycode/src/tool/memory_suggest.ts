import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory_suggest.txt"
import { Memory } from "@/memory/memory"

export const Parameters = Schema.Struct({
  scope: Schema.Literals(["memory", "user"]).annotate({ description: "Suggested target memory file." }),
  section: Schema.String.annotate({ description: "Suggested target section." }),
  content: Schema.String.annotate({ description: "Candidate memory content." }),
  reason: Schema.String.annotate({ description: "Why this may be worth remembering." }),
  confidence: Schema.optional(Schema.Literals(["low", "medium", "high"])).annotate({
    description: "Confidence in this suggestion. Defaults to low.",
  }),
  source: Schema.optional(Schema.String).annotate({ description: "Optional source label. Defaults to current session." }),
})

export const MemorySuggestTool = Tool.define(
  "memory_suggest",
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
            metadata: { action: "suggest", ...params },
          })
          const result = yield* memory.suggest({
            sessionID: ctx.sessionID,
            scope: params.scope,
            section: params.section,
            content: params.content,
            reason: params.reason,
            confidence: params.confidence,
            source: params.source ?? `session:${ctx.sessionID}`,
          })
          return {
            title: "Memory suggestion",
            metadata: { id: result.id, file: result.file, status: result.status, truncated: false },
            output: result.message,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
