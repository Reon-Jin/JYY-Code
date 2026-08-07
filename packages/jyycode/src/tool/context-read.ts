import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./context-read.txt"
import { EpisodicMemory } from "@/memory/episodic"
import { InstanceState } from "@/effect/instance-state"

const Action = Schema.Literals(["digest", "turn", "search"])
type Metadata = { action?: string; turn?: number; matches?: number }

export const Parameters = Schema.Struct({
  action: Action.annotate({
    description: "digest: latest compressed history. turn: full record of one turn. search: keyword search over past turns.",
  }),
  turn: Schema.optional(Schema.Int).annotate({
    description: "Turn number for action=turn (1-based).",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Keyword for action=search.",
  }),
  limit: Schema.optional(Schema.Int).annotate({
    description: "Maximum search results (default 5, max 10).",
  }),
})

export const ContextReadTool = Tool.define(
  "context_read",
  Effect.gen(function* () {
    const episodic = yield* EpisodicMemory.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "memory",
        mutability: "read",
        risk: "low",
        detail: "advanced",
      },
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const root = instance.directory
          if (params.action === "digest") {
            const digest = yield* episodic.readLatestDigest({
              sessionID: ctx.sessionID,
              workspaceRoot: root,
            })
            if (digest._tag === "None") {
              return { title: "Context read", metadata: {}, output: "No episodic digest exists yet." }
            }
            return {
              title: "Context digest",
              metadata: { action: "digest" },
              output: EpisodicMemory.formatEpisodicDigest(digest.value),
            }
          }
          if (params.action === "turn") {
            if (params.turn === undefined) {
              return yield* Effect.fail(new Error("turn is required for action=turn"))
            }
            const episode = yield* episodic.readEpisode({
              sessionID: ctx.sessionID,
              workspaceRoot: root,
              turn: params.turn,
            })
            if (episode._tag === "None") {
              return { title: "Context read", metadata: {}, output: `No episode recorded for turn ${params.turn}.` }
            }
            return {
              title: `Episode turn ${params.turn}`,
              metadata: { action: "turn", turn: params.turn },
              output: JSON.stringify(episode.value, null, 2),
            }
          }
          const query = params.query?.trim()
          if (!query) return yield* Effect.fail(new Error("query is required for action=search"))
          const hits = yield* episodic.searchEpisodes({
            sessionID: ctx.sessionID,
            workspaceRoot: root,
            query,
            limit: params.limit,
          })
          if (hits.length === 0) {
            return { title: "Context search", metadata: {}, output: `No episode matches "${query}".` }
          }
          return {
            title: `Context search: ${query}`,
            metadata: { action: "search", matches: hits.length },
            output: hits
              .map((episode) =>
                [
                  `Turn ${episode.turn} (${episode.time})`,
                  episode.userText ? `User: ${episode.userText}` : undefined,
                  ...episode.toolCalls.map((call) => {
                    const input = EpisodicMemory.truncate(call.input, 400)
                    const result = call.error
                      ? `error=${EpisodicMemory.truncate(call.error, 1000)}`
                      : call.output
                        ? `result=${EpisodicMemory.truncate(call.output, 1000)}`
                        : "no result"
                    return `Tool ${call.tool}: input=${input}\n  ${result}`
                  }),
                  episode.assistantText ? `Assistant: ${episode.assistantText}` : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
              )
              .join("\n\n---\n\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
