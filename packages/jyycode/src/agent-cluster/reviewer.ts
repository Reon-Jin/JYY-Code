export * as AgentClusterReviewer from "./reviewer"

import { AgentClusterTaskTable } from "./cluster.sql"
import { AgentClusterLifecycle } from "./lifecycle"
import type { ReviewDecision, RunID, TaskID } from "./schema"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ConfigAgentCluster } from "@/config/agent-cluster"
import * as Database from "@/storage/db"
import { and, eq } from "@/storage/db"
import { Schema } from "effect"
import { Effect } from "effect"
import { generateObject } from "ai"

export const ReviewInstructions = [
  "Review each subagent result as the cluster primary.",
  "The review must compare submitted artifacts and summaries against the task acceptance criteria and check for any issues or risks.",
  "Return a structured decision: accepted, revision_requested, or failed.",
  "For revision_requested, include concrete issues and a revision prompt that can be sent back to the same subagent with the same session ID (the \"ses_...\" value returned as task_id by the task tool, not your plan's internal id).",
  "Do not accept missing artifacts, missing citations, unverified claims, or outputs that ignore explicit user constraints unless you clearly mark a risk and explain the degradation.",
].join("\n")

export interface ReviewerModel {
  review(input: ReviewInput): Effect.Effect<ReviewDecision, ReviewModelError>
}

export class ReviewModelError {
  readonly _tag = "ReviewModelError"
  constructor(
    readonly message: string,
    readonly retryable: boolean = false,
  ) {}
}

export interface ReviewInput {
  taskPrompt: string
  acceptanceCriteria: readonly string[]
  expectedArtifacts: readonly string[]
  artifactChecks: readonly { path: string; exists: boolean }[]
  resultText: string
  model: string
  role: string
  priorIssues: readonly string[]
  round: number
  dependencySummaries: readonly string[]
}

export const reviewTask = Effect.fn("AgentClusterReviewer.reviewTask")(function* (input: {
  runID: RunID
  taskID: TaskID
  reviewerModel: ReviewerModel
  artifactCheck: (
    paths: readonly string[],
    workspaceDir: string,
  ) => Effect.Effect<readonly { path: string; exists: boolean }[]>
}) {
  return yield* Database.withTransaction((tx) =>
    Effect.gen(function* () {
      const task = yield* tx
        .select()
        .from(AgentClusterTaskTable)
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, input.runID),
            eq(AgentClusterTaskTable.id, input.taskID),
          ),
        )
        .get()

      if (!task || task.status !== "submitted") {
        return yield* Effect.fail(
          new Error(`Task ${input.taskID} is not in submitted status, cannot review`),
        )
      }

      // Transition to reviewing
      const now = Date.now()
      yield* tx
        .update(AgentClusterTaskTable)
        .set({
          status: "reviewing",
          status_version: task.status_version + 1,
          time_updated: now,
        })
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, input.runID),
            eq(AgentClusterTaskTable.id, input.taskID),
          ),
        )
        .run()

      // Build review input
      const reviewInput: ReviewInput = {
        taskPrompt: task.prompt,
        acceptanceCriteria: task.acceptance_criteria,
        expectedArtifacts: task.artifact_paths,
        artifactChecks: [],
        resultText: task.result_text ?? "",
        model: task.model,
        role: task.role,
        priorIssues: task.review_issues ?? [],
        round: task.review_round,
        dependencySummaries: [],
      }

      // Call reviewer model
      const decision = yield* input.reviewerModel.review(reviewInput).pipe(
        Effect.catchAll((err) => {
          if (err instanceof ReviewModelError && err.retryable) {
            // Retry once for transient errors
            return input.reviewerModel.review(reviewInput)
          }
          return Effect.fail(err)
        }),
      )

      // Validate decision consistency
      if (decision.decision === "revision_requested" && !decision.revisionPrompt) {
        return yield* Effect.fail(
          new Error("revision_requested requires a non-empty revisionPrompt"),
        )
      }

      // Persist review result
      const newStatus = decision.decision
      const newVersion = task.status_version + 2
      const reviewRound = task.review_round + 1

      yield* tx
        .update(AgentClusterTaskTable)
        .set({
          status: newStatus,
          status_version: newVersion,
          review_round: reviewRound,
          review_issues: decision.issues,
          revision_prompt: decision.revisionPrompt ?? null,
          last_event: `Review: ${decision.decision}`,
          accepted_at: decision.decision === "accepted" ? now : undefined,
          time_updated: now,
        })
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, input.runID),
            eq(AgentClusterTaskTable.id, input.taskID),
          ),
        )
        .run()

      return decision
    }),
  )
})

export function makeReviewerModel(input: {
  providerID: ProviderID
  modelID: ModelID
}): ReviewerModel {
  return {
    review(reviewInput: ReviewInput) {
      return Effect.gen(function* () {
        const provider = yield* Provider.Service
        const model = yield* provider.getModel(input.providerID, input.modelID)

        const prompt = buildReviewPrompt(reviewInput)

        try {
          const result = yield* Effect.promise(() =>
            generateObject({
              model,
              schema: Schema.toStandardSchemaV1(ReviewDecisionSchema),
              prompt,
            }),
          )

          return result.object as ReviewDecision
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new ReviewModelError(message, true)
        }
      })
    },
  }
}

const ReviewDecisionSchema = Schema.Struct({
  decision: Schema.Literals(["accepted", "revision_requested", "failed"]),
  issues: Schema.Array(Schema.String),
  revisionPrompt: Schema.optional(Schema.String),
  verifiedArtifacts: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
})

function buildReviewPrompt(input: ReviewInput): string {
  return [
    "You are reviewing a subagent task result as part of a Multi-Agent cluster run.",
    "",
    "## Task",
    `Role: ${input.role}`,
    `Model: ${input.model}`,
    `Prompt: ${input.taskPrompt}`,
    "",
    "## Acceptance Criteria",
    ...input.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    "## Expected Artifacts",
    input.expectedArtifacts.length > 0
      ? input.expectedArtifacts.map((a) => `- ${a}`).join("\n")
      : "(none specified)",
    "",
    "## Artifact Checks",
    input.artifactChecks.length > 0
      ? input.artifactChecks.map((c) => `- ${c.path}: ${c.exists ? "exists" : "MISSING"}`).join("\n")
      : "(no artifact checks performed)",
    "",
    "## Subagent Result",
    input.resultText || "(empty result)",
    "",
    input.priorIssues.length > 0
      ? ["## Prior Review Issues", ...input.priorIssues.map((i) => `- ${i}`), ""].join("\n")
      : "",
    `## Review Round: ${input.round}`,
    "",
    "Return a structured decision:",
    "- accepted: all criteria met, all required artifacts present",
    "- revision_requested: issues found, can be fixed (include revisionPrompt)",
    "- failed: cannot be fixed, or max rounds exceeded",
    "",
    "Do NOT accept missing artifacts, unverified claims, or ignored constraints.",
  ].join("\n")
}
