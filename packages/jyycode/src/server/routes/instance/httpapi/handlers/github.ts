import { GitHub } from "@/project/github"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { GitHubCommandError, GitHubDependencyError, GitHubRepositoryError } from "../groups/github"

export const toHttpError = (error: GitHub.GitHubError) => {
  switch (error.reason) {
    case "missing-gh":
    case "not-authenticated":
      return new GitHubDependencyError({ reason: error.reason, message: error.message })
    case "not-github-repo":
    case "conflict":
      return new GitHubRepositoryError({ reason: error.reason, message: error.message })
    case "command-failed":
    case "invalid-response":
      return new GitHubCommandError({ reason: error.reason, message: error.message })
  }
}

const expose = <A, R>(effect: Effect.Effect<A, GitHub.GitHubError, R>) => effect.pipe(Effect.mapError(toHttpError))

export const githubHandlers = HttpApiBuilder.group(InstanceHttpApi, "github", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* GitHub.Service

    return handlers
      .handle("status", () => svc.availability())
      .handle("listPullRequests", ({ query }) => expose(svc.listPullRequests({ state: query.state })))
      .handle("createPullRequest", ({ payload }) => expose(svc.createPullRequest(payload)))
      .handle("getPullRequest", ({ params }) => expose(svc.getPullRequest(params.number)))
      .handle("editPullRequest", ({ params, payload }) =>
        expose(svc.editPullRequest({ number: params.number, ...payload })),
      )
      .handle("getPullRequestDiff", ({ params }) => expose(svc.getPullRequestDiff(params.number)))
      .handle("commentOnPullRequest", ({ params, payload }) =>
        expose(svc.commentOnPullRequest({ number: params.number, body: payload.body })),
      )
      .handle("checkoutPullRequest", ({ params }) => expose(svc.checkoutPullRequest(params.number)))
      .handle("closePullRequest", ({ params }) => expose(svc.closePullRequest(params.number)))
      .handle("reopenPullRequest", ({ params }) => expose(svc.reopenPullRequest(params.number)))
      .handle("mergePullRequest", ({ params, payload }) =>
        expose(svc.mergePullRequest({ number: params.number, ...payload })),
      )
  }),
)
