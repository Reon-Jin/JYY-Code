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
  planner_variant: Schema.optional(Schema.String).annotate({
    description: "Reasoning variant used by the cluster primary agent for planning.",
  }),
  reviewer_model: Schema.optional(Schema.String).annotate({
    description: "Deprecated compatibility setting. Review is performed by the cluster primary model.",
  }),
  reviewer_variant: Schema.optional(Schema.String).annotate({
    description: "Deprecated compatibility setting. Review uses the cluster primary variant.",
  }),
  complex_model: Schema.optional(Schema.String).annotate({
    description: "Default model for complex cluster tasks.",
  }),
  complex_variant: Schema.optional(Schema.String).annotate({
    description: "Reasoning variant used for complex cluster tasks.",
  }),
  simple_model: Schema.optional(Schema.String).annotate({
    description: "Default model for simple cluster tasks.",
  }),
  simple_variant: Schema.optional(Schema.String).annotate({
    description: "Reasoning variant used for simple cluster tasks.",
  }),
  visual_model: Schema.optional(Schema.String).annotate({
    description: "Model used for visual, layout, image-search, chart, and document production tasks.",
  }),
  visual_variant: Schema.optional(Schema.String).annotate({
    description: "Reasoning variant used for visual and document tasks.",
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
  planner_model: "deepseek-v4-flash",
  complex_model: "deepseek-v4-flash",
  simple_model: "deepseek-v4-flash",
  visual_model: "deepseek-v4-flash",
  max_subagents: 100,
  max_concurrency: 10,
  max_review_rounds: 2,
  artifact_dir: ".",
} satisfies Omit<
  Required<Info>,
  "reviewer_model" | "reviewer_variant" | "planner_variant" | "complex_variant" | "simple_variant" | "visual_variant"
>

export function resolve(input: Info | undefined) {
  const { reviewer_model: _legacyReviewerModel, ...overrides } = input ?? {}
  return {
    ...Default,
    ...overrides,
    disable_for_routes: input?.disable_for_routes ?? Default.disable_for_routes,
  }
}
