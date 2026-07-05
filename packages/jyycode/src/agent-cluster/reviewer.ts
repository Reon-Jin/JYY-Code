export * as AgentClusterReviewer from "./reviewer"

import { AgentClusterTaskTable } from "./cluster.sql"
import type { ReviewDecision, RunID, TaskID } from "./schema"
import { Provider } from "@/provider/provider"
import type { Provider as ProviderType } from "@/provider/provider"
import * as Database from "@/storage/db"
import { and, eq } from "@/storage/db"
import { Effect, Schema } from "effect"

export const ReviewInstructions = [
  "Review each subagent result as the cluster primary.",
  "The review must compare submitted artifacts and summaries against the task acceptance criteria and check for any issues or risks.",
  "Return a structured decision: accepted, revision_requested, or failed.",
  "For revision_requested, include concrete issues and a revision prompt that can be sent back to the same subagent with the same session ID (the \"ses_...\" value returned as task_id by the task tool, not your plan's internal id).",
  "Do not accept missing artifacts, missing citations, unverified claims, or outputs that ignore explicit user constraints unless you clearly mark a risk and explain the degradation.",
].join("\n")

export interface ReviewInput {
  taskPrompt: string
  acceptanceCriteria: readonly string[]
  expectedArtifactPaths: readonly string[]
  artifactChecks: readonly { path: string; exists: boolean; kind: string }[]
  resultText: string
  model: string
  role: string
  priorIssues: readonly string[]
  round: number
  dependencySummaries: readonly string[]
}

export class ReviewModelError {
  readonly _tag = "ReviewModelError"
  constructor(
    readonly message: string,
    readonly retryable: boolean = false,
  ) {}
}

// Reviewer model adapter — allows test injection
export interface ReviewerModelAdapter {
  review(input: ReviewInput): Effect.Effect<ReviewDecision, ReviewModelError>
}

// Real AI SDK adapter using Provider.Service
export const makeAISDKReviewer = Effect.fn("AgentClusterReviewer.makeAISDKReviewer")(function* (
  reviewerProviderID: string,
  reviewerModelID: string,
): Effect.Effect<ReviewerModelAdapter> {
  const provider = yield* Provider.Service
  try {
    const model = yield* provider.getModel(reviewerProviderID, reviewerModelID)
    const language = yield* provider.getLanguage(model)
    return makeModelAdapter(language)
  } catch (err) {
    throw new ReviewModelError(
      `Failed to resolve reviewer model ${reviewerProviderID}/${reviewerModelID}: ${err instanceof Error ? err.message : String(err)}`,
      false,
    )
  }
})

// Import generateObject lazily — only used when the real adapter is created
// (tests inject their own adapter, avoiding the AI SDK dependency)
function makeModelAdapter(language: unknown): ReviewerModelAdapter {
  return {
    review(input: ReviewInput) {
      return Effect.gen(function* () {
        // Lazy-import ai to avoid requiring it in test context
        const { generateObject } = yield* Effect.promise(() => import("ai").then((m) => ({ generateObject: m.generateObject })))

        // Build the schema inline
        const ReviewDecisionSchema = Schema.Struct({
          decision: Schema.Literals(["accepted", "revision_requested", "failed"]),
          issues: Schema.Array(Schema.String),
          revisionPrompt: Schema.optional(Schema.String),
          verifiedArtifacts: Schema.Array(Schema.String),
          risks: Schema.Array(Schema.String),
        })

        const prompt = buildReviewPrompt(input)

        try {
          const result = yield* Effect.promise(() =>
            generateObject({
              model: language as any,
              schema: Schema.toStandardSchemaV1(ReviewDecisionSchema),
              prompt,
              temperature: 0.1,
            }),
          )

          const decision = result.object as ReviewDecision

          // Validate decision consistency
          if (decision.decision === "revision_requested" && (!decision.revisionPrompt || decision.revisionPrompt.trim() === "")) {
            throw new ReviewModelError("revision_requested requires a non-empty revisionPrompt", false)
          }

          // Reject acceptance if required artifacts are missing
          const missingArtifacts = input.artifactChecks.filter((c) => !c.exists)
          if (decision.decision === "accepted" && missingArtifacts.length > 0) {
            throw new ReviewModelError(
              `Cannot accept task with missing artifacts: ${missingArtifacts.map((a) => a.path).join(", ")}`,
              false,
            )
          }

          return decision
        } catch (err) {
          if (err instanceof ReviewModelError) throw err
          const message = err instanceof Error ? err.message : String(err)
          throw new ReviewModelError(message, true)
        }
      })
    },
  }
}

// Fake adapter for tests
export function makeFakeReviewer(decision: ReviewDecision): ReviewerModelAdapter {
  return {
    review(_input: ReviewInput) {
      return Effect.succeed(decision)
    },
  }
}

export function makeFakeReviewerFn(
  fn: (input: ReviewInput) => ReviewDecision,
): ReviewerModelAdapter {
  return {
    review(input: ReviewInput) {
      return Effect.succeed(fn(input))
    },
  }
}

// The core review transaction: transitions submitted -> reviewing -> accepted|revision_requested|failed
export const reviewTask = Effect.fn("AgentClusterReviewer.reviewTask")(function* (input: {
  runID: RunID
  taskID: TaskID
  adapter: ReviewerModelAdapter
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
          new Error(`Task ${input.taskID} is not in submitted status`),
        )
      }

      // Transition submitted -> reviewing
      const now = Date.now()
      yield* tx
        .update(AgentClusterTaskTable)
        .set({
          status: "reviewing",
          status_version: task.status_version + 1,
          last_event: "Review started",
          time_updated: now,
        })
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, input.runID),
            eq(AgentClusterTaskTable.id, input.taskID),
            eq(AgentClusterTaskTable.status, "submitted"),
          ),
        )
        .run()

      // Build review input
      const reviewInput: ReviewInput = {
        taskPrompt: task.prompt,
        acceptanceCriteria: task.acceptance_criteria as readonly string[],
        expectedArtifactPaths: task.artifact_paths as readonly string[],
        artifactChecks: [],
        resultText: task.result_text ?? "",
        model: task.model,
        role: task.role,
        priorIssues: (task.review_issues ?? []) as readonly string[],
        round: task.review_round,
        dependencySummaries: [],
      }

      // Call reviewer model (with retry for transient errors)
      const start = Date.now()
      const decision = yield* input.adapter.review(reviewInput).pipe(
        Effect.catchAll((err) => {
          if (err instanceof ReviewModelError && err.retryable) {
            return input.adapter.review(reviewInput)
          }
          return Effect.fail(err)
        }),
      )
      const reviewLatency = Date.now() - start

      // Persist review result
      const newVersion = task.status_version + 2
      const reviewRound = task.review_round + 1

      yield* tx
        .update(AgentClusterTaskTable)
        .set({
          status: decision.decision,
          status_version: newVersion,
          review_round: reviewRound,
          review_issues: decision.issues,
          revision_prompt: decision.decision === "revision_requested" ? (decision.revisionPrompt ?? null) : null,
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

      return { decision, reviewLatency }
    }),
  )
})

export function buildReviewPrompt(input: ReviewInput): string {
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
    input.expectedArtifactPaths.length > 0
      ? input.expectedArtifactPaths.map((a) => `- ${a}`).join("\n")
      : "(none specified)",
    "",
    "## Artifact Checks",
    input.artifactChecks.length > 0
      ? input.artifactChecks.map((c) => `- ${c.path}: ${c.exists ? `exists (${c.kind})` : "MISSING"}`).join("\n")
      : "(no artifact checks performed)",
    "",
    "## Subagent Result",
    input.resultText.slice(0, 50_000) || "(empty result)",
    "",
    input.priorIssues.length > 0
      ? ["## Prior Review Issues", ...input.priorIssues.map((i) => `- ${i}`), ""].join("\n")
      : "",
    `## Review Round: ${input.round + 1}`,
    "",
    "Return a JSON object:",
    '{ "decision": "accepted"|"revision_requested"|"failed", "issues": [...], "revisionPrompt": "..." (if revision_requested), "verifiedArtifacts": [...], "risks": [...] }',
    "",
    "Do NOT accept missing artifacts, unverified claims, or ignored constraints.",
  ].join("\n")
}
