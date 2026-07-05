export * as AgentClusterReviewer from "./reviewer"

import { AgentClusterTaskTable } from "./cluster.sql"
import type { ReviewDecision, RunID, TaskID } from "./schema"
import { Provider } from "@/provider/provider"
import type { Provider as ProviderType } from "@/provider/provider"
import * as Database from "@/storage/db"
import { and, eq } from "@/storage/db"
import { Effect, Schema, Cause } from "effect"

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
              temperature: 0.05,
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
        Effect.catchCause((cause) => {
          const err = Cause.squash(cause)
          if (err instanceof ReviewModelError && err.retryable) {
            return input.adapter.review(reviewInput)
          }
          return Effect.failCause(cause)
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
    "You are a STRICT quality reviewer for a Multi-Agent cluster run. Your job is to find problems. Default to demanding revisions unless the result is genuinely flawless.",
    "",
    "## Review Process (MANDATORY — perform each step, do not skip)",
    "",
    "1. ACCEPTANCE CRITERIA AUDIT: Go through EVERY acceptance criterion one by one. For each, determine if the subagent result CONCRETELY satisfies it. Cite specific evidence from the result text. If ANY criterion is not clearly met, you MUST request revision.",
    "2. ARTIFACT VERIFICATION: Check each expected artifact. If any is MISSING, you MUST request revision (never accept when artifacts are missing). If an artifact exists but its content was not verified, list it as a risk.",
    "3. QUALITY ASSESSMENT: Is the output thorough? Are claims backed by evidence? Are numbers/facts accurate? Is the writing clear and complete? Shallow, vague, or incomplete work MUST be revised.",
    "4. CONSTRAINT CHECK: Are there any ignored requirements from the task prompt? Did the subagent follow all explicit instructions?",
    "",
    "## Decision Rules",
    "- **accepted**: ONLY when ALL criteria are clearly met, ALL artifacts present, output is thorough, and YOU can explain why each criterion is satisfied.",
    "- **revision_requested**: If ANY criterion is not clearly met, ANY artifact missing, output is shallow, or instructions were ignored. You MUST include a specific, actionable revisionPrompt telling the subagent exactly what to fix.",
    "- **failed**: Only if the task is fundamentally impossible or the subagent completely ignored the task.",
    "",
    "CRITICAL: If you are unsure about ANY criterion, request revision. It is always better to ask for improvement than to accept inadequate work.",
    "",
    "## Task",
    `Role: ${input.role}`,
    `Model: ${input.model}`,
    `Prompt: ${input.taskPrompt}`,
    "",
    "## Acceptance Criteria (audit each one!)",
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
      ? ["## Prior Review Issues (must be resolved)", ...input.priorIssues.map((i) => `- ${i}`), ""].join("\n")
      : "",
    `## Review Round: ${input.round + 1}`,
    "",
    "## Your Audit (think step by step, then output JSON)",
    "For EACH acceptance criterion, write one line: 'CRITERION X: [met/not met] because [specific evidence]'. Then output the JSON decision.",
    "",
    '{ "decision": "accepted"|"revision_requested"|"failed", "issues": ["specific issue 1", "specific issue 2"], "revisionPrompt": "detailed instructions for the subagent" (required if revision_requested), "verifiedArtifacts": ["path/to/verified/file"], "risks": ["any remaining concerns"] }',
  ].join("\n")
}
