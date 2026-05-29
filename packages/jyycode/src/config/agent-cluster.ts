export * as ConfigAgentCluster from "./agent-cluster"

import { NonNegativeInt, PositiveInt } from "@jyycode-ai/core/schema"
import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the Multi-Agent execution mode feature. Defaults to true.",
  }),
  default_on: Schema.optional(Schema.Boolean).annotate({
    description: "Enable Multi-Agent mode by default for normal sessions. Defaults to false.",
  }),
  disable_for_routes: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Session routes where Multi-Agent mode is always disabled.",
  }),
  planner_model: Schema.optional(Schema.String).annotate({
    description: "Model used by the cluster primary agent for planning.",
  }),
  reviewer_model: Schema.optional(Schema.String).annotate({
    description: "Model used by the cluster primary agent for review.",
  }),
  complex_model: Schema.optional(Schema.String).annotate({
    description: "Default model for complex cluster tasks.",
  }),
  simple_model: Schema.optional(Schema.String).annotate({
    description: "Default model for simple cluster tasks.",
  }),
  max_subagents: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of subagents a cluster run may dispatch.",
  }),
  max_concurrency: Schema.optional(PositiveInt).annotate({
    description: "Maximum concurrent subagent tasks.",
  }),
  max_review_rounds: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum review revision rounds per cluster task.",
  }),
  artifact_dir: Schema.optional(Schema.String).annotate({
    description: "Workspace-relative directory for cluster artifacts.",
  }),
}).annotate({ identifier: "AgentClusterConfig" })

export type Info = Schema.Schema.Type<typeof Info>

export const Default = {
  enabled: true,
  default_on: false,
  disable_for_routes: ["mail"],
  planner_model: "deepseek-v4-pro",
  reviewer_model: "deepseek-v4-pro",
  complex_model: "deepseek-v4-pro",
  simple_model: "deepseek-v4-flash",
  max_subagents: 10,
  max_concurrency: 8,
  max_review_rounds: 2,
  artifact_dir: ".jyycode/agent-cluster",
} satisfies Required<Info>

export function resolve(input: Info | undefined) {
  return {
    ...Default,
    ...input,
    disable_for_routes: input?.disable_for_routes ?? Default.disable_for_routes,
  }
}
