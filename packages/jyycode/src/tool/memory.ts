import { Effect, Schema } from "effect"
import path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { Memory } from "@/memory/memory"

const Action = Schema.Literals(["add", "replace", "remove", "compact", "read"])
const Target = Schema.Literals(["memory", "user"])
type Metadata = { file: string | undefined; status: string; truncated: boolean }

export const Parameters = Schema.Struct({
  action: Action.annotate({
    description:
      "read: show the selected store's current entries. add: write a new entry. replace: find by old_text and replace. remove: find by old_text and delete. compact: organize the selected store.",
  }),
  target: Target.annotate({
    description: "memory for project facts/conventions, user for personal preferences.",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "The memory content to store. Required for add and replace actions.",
  }),
  importance: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))).annotate({
    description: "Importance from 1 (lowest) to 10 (highest). Required for add.",
  }),
  keywords: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "One to three stable keywords, each 2-4 characters. Required for add; duplicates are normalized automatically.",
  }),
  old_text: Schema.optional(Schema.String).annotate({
    description:
      "Substring to identify the entry to replace or remove. Must uniquely match a single entry. Required for replace and remove actions.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Why this change should be remembered.",
  }),
})

export const MemoryTool = Tool.define(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "memory",
        mutability: "write",
        risk: "medium",
        detail: "standard",
      },
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          if (params.action === "read") {
            const directory = yield* memory.dir(ctx.sessionID)
            const scope = params.target satisfies "memory" | "user"
            const text = yield* memory.read({ sessionID: ctx.sessionID, scope })
            const file = path.join(directory, params.target === "memory" ? "MEMORY.json" : "USER.json")
            return {
              title: `Memory read (${params.target})`,
              metadata: { file, status: "read", truncated: false },
              output: text,
            }
          }

          yield* ctx.ask({
            permission: "memory",
            patterns: [params.action, params.target],
            always: ["*"],
            metadata: { action: params.action, target: params.target },
          })

          const sessionID = ctx.sessionID
          const scope = params.target satisfies "memory" | "user"
          const reason = params.reason ?? `User requested: ${params.action} memory`

          if (params.action === "add") {
            if (!params.content) return yield* Effect.fail(new Error("content is required for add action"))
            if (params.importance === undefined)
              return yield* Effect.fail(new Error("importance is required for add action"))
            if (!params.keywords) return yield* Effect.fail(new Error("keywords are required for add action"))
            const structured = {
              sessionID,
              importance: params.importance as Memory.Importance,
              keywords: [...params.keywords],
              content: params.content,
            }
            const result =
              scope === "memory"
                ? yield* memory.upsertTaskMemory(structured)
                : yield* memory.upsertUserMemory(structured)
            return {
              title: "Memory add",
              metadata: { file: result.file, status: result.status, truncated: false },
              output: result.message,
            }
          }

          if (params.action === "replace") {
            if (!params.old_text) return yield* Effect.fail(new Error("old_text is required for replace action"))
            if (!params.content) return yield* Effect.fail(new Error("content is required for replace action"))
            const result = yield* memory.replaceBySubstring({
              sessionID,
              scope,
              oldText: params.old_text,
              newContent: params.content,
              reason,
            })
            return {
              title: "Memory replace",
              metadata: { file: result.file, status: result.status, truncated: false },
              output: result.message,
            }
          }

          if (params.action === "remove") {
            if (!params.old_text) return yield* Effect.fail(new Error("old_text is required for remove action"))
            const result = yield* memory.removeBySubstring({
              sessionID,
              scope,
              oldText: params.old_text,
              reason,
            })
            return {
              title: "Memory remove",
              metadata: { file: result.file, status: result.status, truncated: false },
              output: result.message,
            }
          }

          if (params.action === "compact") {
            const result = yield* memory.compact({ sessionID, scope })
            return {
              title: "Memory compact",
              metadata: { file: result.file, status: result.status, truncated: false },
              output: result.message,
            }
          }

          return yield* Effect.fail(new Error(`Unknown action: ${params.action}`))
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              title: "Memory error",
              metadata: { file: undefined, status: "error", truncated: false },
              output: error instanceof Error ? error.message : String(error),
            }),
          ),
        ),
    }
  }),
)
