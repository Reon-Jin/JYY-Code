import { GitHub } from "@/project/github"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/github"
const pulls = `${root}/pulls`
const pull = `${pulls}/:number`

const PullRequestNumber = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)).annotate({
  identifier: "GitHubPullRequestNumber",
})
const NonBlankString = Schema.String.check(Schema.isPattern(/\S/))

const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  state: Schema.optional(GitHub.PullRequestStateFilter),
})
const CreatePayload = Schema.Struct({
  head: NonBlankString,
  base: NonBlankString,
  title: NonBlankString,
  body: NonBlankString,
  draft: Schema.optional(Schema.Boolean),
})
const EditPayload = Schema.Struct({
  title: NonBlankString,
  body: NonBlankString,
})
const CommentPayload = Schema.Struct({ body: NonBlankString })
const MergePayload = Schema.Struct({
  method: GitHub.MergeMethod,
  deleteBranch: Schema.optional(Schema.Boolean),
})

export class GitHubDependencyError extends Schema.TaggedErrorClass<GitHubDependencyError>()(
  "GitHubDependencyError",
  {
    reason: Schema.Literals(["missing-gh", "not-authenticated"]),
    message: Schema.String,
  },
  { httpApiStatus: 424 },
) {}

export class GitHubRepositoryError extends Schema.TaggedErrorClass<GitHubRepositoryError>()(
  "GitHubRepositoryError",
  {
    reason: Schema.Literals(["not-github-repo", "conflict"]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class GitHubCommandError extends Schema.TaggedErrorClass<GitHubCommandError>()(
  "GitHubCommandError",
  {
    reason: Schema.Literals(["command-failed", "invalid-response"]),
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}

const errors = [GitHubDependencyError, GitHubRepositoryError, GitHubCommandError] as const

const group = HttpApiGroup.make("github")
  .add(
    HttpApiEndpoint.get("status", `${root}/status`, {
      query: WorkspaceRoutingQuery,
      success: described(GitHub.Availability, "GitHub CLI and repository availability"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.status",
        summary: "Get GitHub availability",
        description: "Check GitHub CLI authentication and repository connectivity for the selected workspace.",
      }),
    ),
    HttpApiEndpoint.get("listPullRequests", pulls, {
      query: ListQuery,
      success: described(Schema.Array(GitHub.PullRequestSummary), "Pull requests"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.pull.list",
        summary: "List pull requests",
        description: "List pull requests for the selected workspace repository.",
      }),
    ),
    HttpApiEndpoint.post("createPullRequest", pulls, {
      query: WorkspaceRoutingQuery,
      payload: CreatePayload,
      success: described(GitHub.PullRequestReference, "Created pull request"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.pull.create",
        summary: "Create pull request",
        description: "Create a pull request from the selected workspace repository.",
      }),
    ),
    HttpApiEndpoint.get("getPullRequest", pull, {
      params: { number: PullRequestNumber },
      query: WorkspaceRoutingQuery,
      success: described(GitHub.PullRequestDetail, "Pull request detail"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.pull.get",
        summary: "Get pull request",
        description: "Get pull request metadata, comments, commits, and checks.",
      }),
    ),
    HttpApiEndpoint.patch("editPullRequest", pull, {
      params: { number: PullRequestNumber },
      query: WorkspaceRoutingQuery,
      payload: EditPayload,
      success: described(GitHub.MutationResult, "Pull request update result"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.pull.edit",
        summary: "Edit pull request",
        description: "Update the title and body of a pull request.",
      }),
    ),
    HttpApiEndpoint.get("getPullRequestDiff", `${pull}/diff`, {
      params: { number: PullRequestNumber },
      query: WorkspaceRoutingQuery,
      success: described(GitHub.PullRequestDiff, "Unified pull request diff"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.pull.diff",
        summary: "Get pull request diff",
        description: "Get the unified diff for a pull request.",
      }),
    ),
    HttpApiEndpoint.post("commentOnPullRequest", `${pull}/comments`, {
      params: { number: PullRequestNumber },
      query: WorkspaceRoutingQuery,
      payload: CommentPayload,
      success: described(GitHub.MutationResult, "Comment result"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.pull.comment",
        summary: "Comment on pull request",
        description: "Add a comment to a pull request.",
      }),
    ),
    HttpApiEndpoint.post("checkoutPullRequest", `${pull}/checkout`, {
      params: { number: PullRequestNumber },
      query: WorkspaceRoutingQuery,
      success: described(GitHub.MutationResult, "Checkout result"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.pull.checkout",
        summary: "Checkout pull request",
        description: "Checkout a pull request in the selected workspace.",
      }),
    ),
    HttpApiEndpoint.post("closePullRequest", `${pull}/close`, {
      params: { number: PullRequestNumber },
      query: WorkspaceRoutingQuery,
      success: described(GitHub.MutationResult, "Close result"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.pull.close",
        summary: "Close pull request",
        description: "Close a pull request without merging it.",
      }),
    ),
    HttpApiEndpoint.post("reopenPullRequest", `${pull}/reopen`, {
      params: { number: PullRequestNumber },
      query: WorkspaceRoutingQuery,
      success: described(GitHub.MutationResult, "Reopen result"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.pull.reopen",
        summary: "Reopen pull request",
        description: "Reopen a closed pull request.",
      }),
    ),
    HttpApiEndpoint.post("mergePullRequest", `${pull}/merge`, {
      params: { number: PullRequestNumber },
      query: WorkspaceRoutingQuery,
      payload: MergePayload,
      success: described(GitHub.MutationResult, "Merge result"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "github.pull.merge",
        summary: "Merge pull request",
        description: "Merge a pull request using the selected merge method.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "github",
      description: "Workspace-scoped GitHub pull request operations.",
    }),
  )
  .middleware(InstanceContextMiddleware)
  .middleware(WorkspaceRoutingMiddleware)
  .middleware(Authorization)

export const GitHubApi = HttpApi.make("github-api").add(group)
