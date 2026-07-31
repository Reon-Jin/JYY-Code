import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { WorkflowLedger } from "@/workflow/ledger"

const ContextSearchParameters = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
})
const ContextGetParameters = Schema.Struct({ id: Schema.String })
const ArtifactGetParameters = Schema.Struct({ uri: Schema.String })

export const ContextSearchTool = Tool.define(
  "context_search",
  Effect.succeed({
    description: "Search persisted workflow context for the current session, including user constraints, artifacts, and review evidence.",
    parameters: ContextSearchParameters,
    catalog: { category: "memory", mutability: "read", risk: "low", detail: "standard" },
    execute: (input: Schema.Schema.Type<typeof ContextSearchParameters>, ctx) =>
      WorkflowLedger.searchContext({ sessionID: ctx.sessionID, query: input.query, limit: input.limit }).pipe(
        Effect.map((blocks) => ({
          title: "Workflow context",
          metadata: { count: blocks.length },
          output: blocks.map((block) => `${block.id} [${block.source}/${block.priority}] ${block.content}`).join("\n\n") || "No matching context.",
        })),
      ),
  }),
)

export const ContextGetTool = Tool.define(
  "context_get",
  Effect.succeed({
    description: "Read one persisted workflow context block by id.",
    parameters: ContextGetParameters,
    catalog: { category: "memory", mutability: "read", risk: "low", detail: "standard" },
    execute: (input: Schema.Schema.Type<typeof ContextGetParameters>) =>
      WorkflowLedger.getContext(input.id).pipe(
        Effect.map((block) => ({ title: "Workflow context", metadata: { id: block.id }, output: block.content })),
      ).pipe(Effect.orDie),
  }),
)

export const ArtifactGetTool = Tool.define(
  "artifact_get",
  Effect.succeed({
    description: "Read a structured artifact by its artifact:// URI.",
    parameters: ArtifactGetParameters,
    catalog: { category: "memory", mutability: "read", risk: "low", detail: "standard" },
    execute: (input: Schema.Schema.Type<typeof ArtifactGetParameters>) =>
      WorkflowLedger.getArtifact(input.uri).pipe(
        Effect.map((artifact) => ({
          title: artifact.name,
          metadata: { uri: artifact.uri, mediaType: artifact.mediaType },
          output: artifact.content ?? artifact.summary,
        })),
      ).pipe(Effect.orDie),
  }),
)
