import { AppProcess } from "@jyycode-ai/core/process"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { Vcs } from "@/project/vcs"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"

const MAX_OUTPUT_BYTES = 5_000_000
const MAX_ERROR_BYTES = 32_000

export const Repository = Schema.Struct({
  nameWithOwner: Schema.String,
  url: Schema.String,
  defaultBranch: Schema.String,
}).annotate({ identifier: "GitHubRepository" })
export type Repository = Schema.Schema.Type<typeof Repository>

export const Availability = Schema.Union([
  Schema.Struct({ available: Schema.Literal(true), repository: Repository }),
  Schema.Struct({
    available: Schema.Literal(false),
    reason: Schema.Literals(["missing-gh", "not-authenticated", "not-github-repo", "command-failed"]),
    message: Schema.String,
  }),
]).annotate({ discriminator: "available", identifier: "GitHubAvailability" })
export type Availability = Schema.Schema.Type<typeof Availability>

export const PullRequestAuthor = Schema.Struct({
  login: Schema.String,
  name: Schema.optional(Schema.String),
}).annotate({ identifier: "GitHubPullRequestAuthor" })
export type PullRequestAuthor = Schema.Schema.Type<typeof PullRequestAuthor>

export const PullRequestSummary = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  author: PullRequestAuthor,
  updatedAt: Schema.String,
  url: Schema.String,
  reviewDecision: Schema.optional(Schema.String),
}).annotate({ identifier: "GitHubPullRequestSummary" })
export type PullRequestSummary = Schema.Schema.Type<typeof PullRequestSummary>

export const PullRequestComment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  author: PullRequestAuthor,
  createdAt: Schema.String,
  url: Schema.optional(Schema.String),
}).annotate({ identifier: "GitHubPullRequestComment" })
export type PullRequestComment = Schema.Schema.Type<typeof PullRequestComment>

export const PullRequestCommit = Schema.Struct({
  oid: Schema.String,
  messageHeadline: Schema.String,
  authoredDate: Schema.String,
  authors: Schema.Array(PullRequestAuthor),
}).annotate({ identifier: "GitHubPullRequestCommit" })
export type PullRequestCommit = Schema.Schema.Type<typeof PullRequestCommit>

export const PullRequestCheck = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.optional(Schema.String),
  detailsUrl: Schema.optional(Schema.String),
}).annotate({ identifier: "GitHubPullRequestCheck" })
export type PullRequestCheck = Schema.Schema.Type<typeof PullRequestCheck>

export const PullRequestDetail = Schema.Struct({
  ...PullRequestSummary.fields,
  body: Schema.String,
  mergeable: Schema.String,
  comments: Schema.Array(PullRequestComment),
  commits: Schema.Array(PullRequestCommit),
  checks: Schema.Array(PullRequestCheck),
}).annotate({ identifier: "GitHubPullRequestDetail" })
export type PullRequestDetail = Schema.Schema.Type<typeof PullRequestDetail>

export const PullRequestDiff = Schema.String.annotate({ identifier: "GitHubPullRequestDiff" })
export type PullRequestDiff = Schema.Schema.Type<typeof PullRequestDiff>

export const PullRequestStateFilter = Schema.Literals(["open", "closed", "merged", "all"])
export type PullRequestStateFilter = Schema.Schema.Type<typeof PullRequestStateFilter>

export const ListPullRequestsInput = Schema.Struct({
  state: Schema.optional(PullRequestStateFilter),
}).annotate({ identifier: "GitHubListPullRequestsInput" })
export type ListPullRequestsInput = Schema.Schema.Type<typeof ListPullRequestsInput>

export const CreatePullRequestInput = Schema.Struct({
  head: Schema.String,
  base: Schema.String,
  title: Schema.String,
  body: Schema.String,
  draft: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "GitHubCreatePullRequestInput" })
export type CreatePullRequestInput = Schema.Schema.Type<typeof CreatePullRequestInput>

export const EditPullRequestInput = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.String,
}).annotate({ identifier: "GitHubEditPullRequestInput" })
export type EditPullRequestInput = Schema.Schema.Type<typeof EditPullRequestInput>

export const CommentPullRequestInput = Schema.Struct({
  number: Schema.Number,
  body: Schema.String,
}).annotate({ identifier: "GitHubCommentPullRequestInput" })
export type CommentPullRequestInput = Schema.Schema.Type<typeof CommentPullRequestInput>

export const MergeMethod = Schema.Literals(["merge", "squash", "rebase"])
export type MergeMethod = Schema.Schema.Type<typeof MergeMethod>

export const MergePullRequestInput = Schema.Struct({
  number: Schema.Number,
  method: MergeMethod,
  deleteBranch: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "GitHubMergePullRequestInput" })
export type MergePullRequestInput = Schema.Schema.Type<typeof MergePullRequestInput>

export const PullRequestReference = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
}).annotate({ identifier: "GitHubPullRequestReference" })
export type PullRequestReference = Schema.Schema.Type<typeof PullRequestReference>

export const MutationResult = Schema.Struct({ success: Schema.Boolean }).annotate({
  identifier: "GitHubMutationResult",
})
export type MutationResult = Schema.Schema.Type<typeof MutationResult>

export const ErrorReason = Schema.Literals([
  "missing-gh",
  "not-authenticated",
  "not-github-repo",
  "conflict",
  "command-failed",
  "invalid-response",
])
export type ErrorReason = Schema.Schema.Type<typeof ErrorReason>

export class GitHubError extends Schema.TaggedErrorClass<GitHubError>()("GitHubError", {
  message: Schema.String,
  reason: ErrorReason,
}) {}

const RepositoryResponse = Schema.Struct({
  nameWithOwner: Schema.String,
  url: Schema.String,
  defaultBranchRef: Schema.Struct({ name: Schema.String }),
})

const PullRequestDetailResponse = Schema.Struct({
  ...PullRequestSummary.fields,
  body: Schema.String,
  mergeable: Schema.String,
  comments: Schema.Array(PullRequestComment),
  commits: Schema.Array(PullRequestCommit),
  statusCheckRollup: Schema.Array(PullRequestCheck),
})

const decodeRepository = Schema.decodeUnknownEffect(Schema.fromJsonString(RepositoryResponse))
const decodePullRequestList = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(PullRequestSummary)))
const decodePullRequestDetail = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestDetailResponse))

const SUMMARY_FIELDS = "number,title,state,isDraft,headRefName,baseRefName,author,updatedAt,url,reviewDecision"
const DETAIL_FIELDS = `${SUMMARY_FIELDS},body,mergeable,comments,commits,statusCheckRollup`

const redact = (value: string) =>
  value
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://***@")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/^authorization:.*$/gim, "authorization: [redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 2_000)

const errorMessage = (error: AppProcess.AppProcessError, fallback: string) => {
  const cause = error.cause instanceof Error ? error.cause.message : error.cause ? String(error.cause) : ""
  return redact(error.stderr || cause || fallback)
}

const resultMessage = (result: AppProcess.RunResult, fallback: string) =>
  redact(result.stderr.toString("utf8") || fallback)

const missingExecutable = (exitCode: number | undefined, message: string) =>
  exitCode === 127 || /command not found|not recognized|cannot find|enoent/i.test(message)

const commandReason = (exitCode: number | undefined, message: string): ErrorReason => {
  if (missingExecutable(exitCode, message)) return "missing-gh"
  if (
    /not logged in|not authenticated|gh auth login|authentication required|GH_TOKEN environment variable/i.test(message)
  ) {
    return "not-authenticated"
  }
  if (
    /no (?:git )?remotes|not a git repository|could not determine (?:base )?repo|none of the git remotes/i.test(message)
  ) {
    return "not-github-repo"
  }
  if (/local changes|would be overwritten|please commit your changes/i.test(message)) return "conflict"
  return "command-failed"
}

export interface Interface {
  readonly availability: () => Effect.Effect<Availability>
  readonly listPullRequests: (
    input?: ListPullRequestsInput,
  ) => Effect.Effect<readonly PullRequestSummary[], GitHubError>
  readonly getPullRequest: (number: number) => Effect.Effect<PullRequestDetail, GitHubError>
  readonly getPullRequestDiff: (number: number) => Effect.Effect<PullRequestDiff, GitHubError>
  readonly createPullRequest: (input: CreatePullRequestInput) => Effect.Effect<PullRequestReference, GitHubError>
  readonly editPullRequest: (input: EditPullRequestInput) => Effect.Effect<MutationResult, GitHubError>
  readonly commentOnPullRequest: (input: CommentPullRequestInput) => Effect.Effect<MutationResult, GitHubError>
  readonly checkoutPullRequest: (number: number) => Effect.Effect<MutationResult, GitHubError>
  readonly closePullRequest: (number: number) => Effect.Effect<MutationResult, GitHubError>
  readonly reopenPullRequest: (number: number) => Effect.Effect<MutationResult, GitHubError>
  readonly mergePullRequest: (input: MergePullRequestInput) => Effect.Effect<MutationResult, GitHubError>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/GitHub") {}

export const layer: Layer.Layer<Service, never, AppProcess.Service | Bus.Service | Git.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const bus = yield* Bus.Service
    const git = yield* Git.Service

    const run = Effect.fnUntraced(function* (args: string[]) {
      const ctx = yield* InstanceState.context
      return yield* appProcess.run(
        ChildProcess.make("gh", args, {
          cwd: ctx.directory,
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
        { maxOutputBytes: MAX_OUTPUT_BYTES, maxErrorBytes: MAX_ERROR_BYTES },
      )
    })

    const attempt = <A>(effect: Effect.Effect<A, AppProcess.AppProcessError>) =>
      effect.pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      )

    const command = Effect.fnUntraced(function* (args: string[]) {
      const executed = yield* attempt(run(args))
      if (!executed.ok) {
        const message = errorMessage(executed.error, "GitHub CLI command failed")
        return yield* new GitHubError({
          message,
          reason: commandReason(executed.error.exitCode, message),
        })
      }
      if (executed.result.exitCode !== 0) {
        const message = resultMessage(executed.result, "GitHub CLI command failed")
        return yield* new GitHubError({
          message,
          reason: commandReason(executed.result.exitCode, message),
        })
      }
      return executed.result
    })

    const invalidResponse = () =>
      new GitHubError({ message: "GitHub CLI returned an invalid response", reason: "invalid-response" })

    const mutation = Effect.fnUntraced(function* (args: string[]) {
      yield* command(args)
      return { success: true } satisfies MutationResult
    })

    const availability = Effect.fn("GitHub.availability")(function* () {
      const version = yield* attempt(run(["--version"]))
      if (!version.ok) {
        const message = errorMessage(version.error, "GitHub CLI could not be started")
        return {
          available: false,
          reason: missingExecutable(version.error.exitCode, message) ? "missing-gh" : "command-failed",
          message,
        } satisfies Availability
      }
      if (version.result.exitCode !== 0) {
        const message = resultMessage(version.result, "GitHub CLI could not be started")
        return {
          available: false,
          reason: missingExecutable(version.result.exitCode, message) ? "missing-gh" : "command-failed",
          message,
        } satisfies Availability
      }

      const auth = yield* attempt(run(["auth", "status", "--hostname", "github.com"]))
      if (!auth.ok) {
        return {
          available: false,
          reason: "command-failed",
          message: errorMessage(auth.error, "GitHub authentication could not be checked"),
        } satisfies Availability
      }
      if (auth.result.exitCode !== 0) {
        return {
          available: false,
          reason: "not-authenticated",
          message: resultMessage(auth.result, "GitHub CLI is not authenticated"),
        } satisfies Availability
      }

      const repository = yield* attempt(run(["repo", "view", "--json", "nameWithOwner,defaultBranchRef,url"]))
      if (!repository.ok) {
        return {
          available: false,
          reason: "command-failed",
          message: errorMessage(repository.error, "The GitHub repository could not be checked"),
        } satisfies Availability
      }
      if (repository.result.exitCode !== 0) {
        const message = resultMessage(repository.result, "The current project is not connected to a GitHub repository")
        return {
          available: false,
          reason:
            commandReason(repository.result.exitCode, message) === "not-github-repo"
              ? "not-github-repo"
              : "command-failed",
          message,
        } satisfies Availability
      }

      const decoded = yield* decodeRepository(repository.result.stdout.toString("utf8")).pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        Effect.catch(() => Effect.succeed({ ok: false as const })),
      )
      if (!decoded.ok) {
        return {
          available: false,
          reason: "command-failed",
          message: "GitHub CLI returned an invalid repository response",
        } satisfies Availability
      }
      return {
        available: true,
        repository: {
          nameWithOwner: decoded.result.nameWithOwner,
          url: decoded.result.url,
          defaultBranch: decoded.result.defaultBranchRef.name,
        },
      } satisfies Availability
    })

    const listPullRequests = Effect.fn("GitHub.listPullRequests")(function* (input: ListPullRequestsInput = {}) {
      const result = yield* command([
        "pr",
        "list",
        "--state",
        input.state ?? "all",
        "--limit",
        "100",
        "--json",
        SUMMARY_FIELDS,
      ])
      return yield* decodePullRequestList(result.stdout.toString("utf8")).pipe(Effect.mapError(() => invalidResponse()))
    })

    const getPullRequest = Effect.fn("GitHub.getPullRequest")(function* (number: number) {
      const result = yield* command(["pr", "view", String(number), "--json", DETAIL_FIELDS])
      const decoded = yield* decodePullRequestDetail(result.stdout.toString("utf8")).pipe(
        Effect.mapError(() => invalidResponse()),
      )
      const { statusCheckRollup, ...detail } = decoded
      return { ...detail, checks: statusCheckRollup }
    })

    const getPullRequestDiff = Effect.fn("GitHub.getPullRequestDiff")(function* (number: number) {
      const result = yield* command(["pr", "diff", String(number)])
      if (result.stdoutTruncated) return yield* invalidResponse()
      return result.stdout.toString("utf8")
    })

    const createPullRequest = Effect.fn("GitHub.createPullRequest")(function* (input: CreatePullRequestInput) {
      const args = [
        "pr",
        "create",
        "--head",
        input.head,
        "--base",
        input.base,
        "--title",
        input.title,
        "--body",
        input.body,
      ]
      if (input.draft) args.push("--draft")
      const result = yield* command(args)
      const url = result.stdout.toString("utf8").trim()
      const number = Number.parseInt(/\/pull\/(\d+)\/?$/.exec(url)?.[1] ?? "", 10)
      if (!url || !Number.isSafeInteger(number) || number <= 0) return yield* invalidResponse()
      return { number, url }
    })

    const editPullRequest = Effect.fn("GitHub.editPullRequest")((input: EditPullRequestInput) =>
      mutation(["pr", "edit", String(input.number), "--title", input.title, "--body", input.body]),
    )

    const commentOnPullRequest = Effect.fn("GitHub.commentOnPullRequest")((input: CommentPullRequestInput) =>
      mutation(["pr", "comment", String(input.number), "--body", input.body]),
    )

    const checkoutPullRequest = Effect.fn("GitHub.checkoutPullRequest")(function* (number: number) {
      const result = yield* mutation(["pr", "checkout", String(number)])
      const ctx = yield* InstanceState.context
      yield* bus.publish(Vcs.Event.BranchUpdated, { branch: yield* git.branch(ctx.directory) })
      return result
    })

    const closePullRequest = Effect.fn("GitHub.closePullRequest")((number: number) =>
      mutation(["pr", "close", String(number)]),
    )

    const reopenPullRequest = Effect.fn("GitHub.reopenPullRequest")((number: number) =>
      mutation(["pr", "reopen", String(number)]),
    )

    const mergePullRequest = Effect.fn("GitHub.mergePullRequest")((input: MergePullRequestInput) => {
      const args = ["pr", "merge", String(input.number), `--${input.method}`]
      if (input.deleteBranch) args.push("--delete-branch")
      return mutation(args)
    })

    return Service.of({
      availability,
      listPullRequests,
      getPullRequest,
      getPullRequestDiff,
      createPullRequest,
      editPullRequest,
      commentOnPullRequest,
      checkoutPullRequest,
      closePullRequest,
      reopenPullRequest,
      mergePullRequest,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(Git.defaultLayer),
)

export * as GitHub from "./github"
