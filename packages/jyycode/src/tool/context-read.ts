import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./context-read.txt"
import { EpisodicMemory } from "@/memory/episodic"
import { ExperienceMemory } from "@/memory/experience"
import { InstanceState } from "@/effect/instance-state"

const Action = Schema.Literals(["digest", "turn", "search", "experience"])
const Kind = Schema.Literals(["success", "failure", "lesson"])
type Metadata = { action?: string; turn?: number; matches?: number }

export const Parameters = Schema.Struct({
  action: Schema.optional(Action).annotate({
    description:
      "What to read (defaults to digest). digest: latest compressed history. turn: full record of one turn. search: keyword search over past turns. experience: search reusable success/failure/lesson rules.",
  }),
  turn: Schema.optional(Schema.Int).annotate({
    description: "Turn number for action=turn (1-based).",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Keyword for action=search; optional for action=experience (omit to list recent active rules).",
  }),
  kind: Schema.optional(Kind).annotate({
    description: "Optional kind filter for action=experience.",
  }),
  limit: Schema.optional(Schema.Int).annotate({
    description: "Maximum search results (default 5, max 10).",
  }),
})

export const ContextReadTool = Tool.define(
  "context_read",
  Effect.gen(function* () {
    const episodic = yield* EpisodicMemory.Service
    const capturedExperience = Option.getOrUndefined(yield* Effect.serviceOption(ExperienceMemory.Service))
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
          const action = params.action ?? "digest"
          if (action === "digest") {
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
          if (action === "turn") {
            if (params.turn === undefined) {
              return {
                title: "Context read",
                metadata: { action: "turn" },
                output:
                  'action=turn requires a 1-based turn number: pass {"action":"turn","turn":3}. Omit action to read the latest digest.',
              }
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
          if (action === "experience") {
            const experienceMemory =
              capturedExperience ?? Option.getOrUndefined(yield* Effect.serviceOption(ExperienceMemory.Service))
            if (!experienceMemory) {
              return {
                title: "Context read",
                metadata: { action: "experience" },
                output: "Experience memory is unavailable in this runtime.",
              }
            }
            const query = params.query?.trim()
            const limit = Math.min(10, Math.max(1, params.limit ?? 5))
            const hits = query
              ? yield* experienceMemory.search({
                  sessionID: ctx.sessionID,
                  query,
                  kind: params.kind,
                  limit,
                  workspaceRoot: root,
                })
              : (yield* experienceMemory.readStore(ctx.sessionID, root)).entries
                  .filter((entry) => entry.status === "active" && (!params.kind || entry.kind === params.kind))
                  .sort(
                    (left, right) =>
                      right.importance - left.importance || right.updatedAt.localeCompare(left.updatedAt),
                  )
                  .slice(0, limit)
            if (hits.length === 0) {
              return {
                title: query ? `Experience search: ${query}` : "Experience list",
                metadata: {},
                output: query ? `No experience matches "${query}".` : "No experience entries yet.",
              }
            }
            return {
              title: query ? `Experience search: ${query}` : "Experience list",
              metadata: { action: "experience", matches: hits.length },
              output: hits
                .map((entry) =>
                  [
                    `[${entry.kind}] importance=${entry.importance} uses=${entry.uses} date=${entry.date}`,
                    `Rule: ${entry.content}`,
                    `Evidence: ${entry.evidence}`,
                  ].join("\n"),
                )
                .join("\n\n---\n\n"),
            }
          }
          const query = params.query?.trim()
          if (!query) {
            return {
              title: "Context search",
              metadata: { action: "search" },
              output: 'action=search requires a query: pass {"action":"search","query":"<keyword>"}.',
            }
          }
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
