import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory_search.txt"
import { Memory } from "@/memory/memory"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Search query for persistent memory" }),
  scope: Schema.optional(Schema.Literals(["memory", "user", "all"])).annotate({
    description: "Which memory file to search. Defaults to all.",
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum number of results. Defaults to 8." }),
  concepts: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional concept tags to filter results by (e.g. ['python', 'fastapi']).",
  }),
})

export const MemorySearchTool = Tool.define(
  "memory_search",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "memory",
            patterns: [params.scope ?? "all"],
            always: ["*"],
            metadata: { query: params.query, scope: params.scope, limit: params.limit },
          })
          const results = yield* memory.search({
            sessionID: ctx.sessionID,
            query: params.query,
            scope: params.scope,
            limit: params.limit,
            concepts: params.concepts as string[] | undefined,
          })
          const output =
            results.length === 0
              ? "No matching persistent memory found."
              : results
                  .map((item) => `${item.file}:${item.line} [${item.section}] score=${item.score}\n${item.text}`)
                  .join("\n\n")
          return {
            title: "Memory search",
            metadata: { matches: results.length, truncated: false },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
