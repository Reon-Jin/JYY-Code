import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { GitHub } from "../../src/project/github"
import { Session } from "../../src/session/session"
import { InstanceHttpApi } from "../../src/server/routes/instance/httpapi/api"
import {
  GitHubApi,
  GitHubCommandError,
  GitHubDependencyError,
  GitHubRepositoryError,
} from "../../src/server/routes/instance/httpapi/groups/github"
import { toHttpError } from "../../src/server/routes/instance/httpapi/handlers/github"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { testEffect } from "../lib/effect"

type Operation = { readonly operationId?: string }
type PathItem = {
  readonly get?: Operation
  readonly post?: Operation
  readonly patch?: Operation
}
type OpenApiSpec = { readonly paths: Record<string, PathItem> }

const TestHttpApi = HttpApi.make("jyycode-instance").addHttpApi(GitHubApi)
const unexpected = () => Effect.die("unexpected GitHub handler invocation")
const testGitHubHandlers = HttpApiBuilder.group(TestHttpApi, "github", (handlers) =>
  handlers
    .handle("status", unexpected)
    .handle("listPullRequests", unexpected)
    .handle("createPullRequest", unexpected)
    .handle("getPullRequest", unexpected)
    .handle("editPullRequest", unexpected)
    .handle("getPullRequestDiff", unexpected)
    .handle("commentOnPullRequest", unexpected)
    .handle("checkoutPullRequest", unexpected)
    .handle("closePullRequest", unexpected)
    .handle("reopenPullRequest", unexpected)
    .handle("mergePullRequest", unexpected),
)
const passthroughAuthorization = Layer.succeed(
  Authorization,
  Authorization.of((effect) => effect),
)
const fakeSession = Layer.mock(Session.Service)({})
const passthroughInstanceContext = Layer.succeed(
  InstanceContextMiddleware,
  InstanceContextMiddleware.of((effect) => effect),
)
const testWorkspaceRouting = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory: process.cwd() }))),
  ),
)
const testApiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(TestHttpApi).pipe(
    Layer.provide(testGitHubHandlers),
    Layer.provide([passthroughAuthorization, passthroughInstanceContext, testWorkspaceRouting, fakeSession]),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
const it = testEffect(testApiLayer)

describe("GitHub HttpApi contract", () => {
  test("publishes the complete workspace-scoped pull request surface", () => {
    const spec = OpenApi.fromApi(InstanceHttpApi) as OpenApiSpec

    expect(spec.paths["/github/status"]?.get?.operationId).toBe("github.status")
    expect(spec.paths["/github/pulls"]?.get?.operationId).toBe("github.pull.list")
    expect(spec.paths["/github/pulls"]?.post?.operationId).toBe("github.pull.create")
    expect(spec.paths["/github/pulls/{number}"]?.get?.operationId).toBe("github.pull.get")
    expect(spec.paths["/github/pulls/{number}"]?.patch?.operationId).toBe("github.pull.edit")
    expect(spec.paths["/github/pulls/{number}/diff"]?.get?.operationId).toBe("github.pull.diff")
    expect(spec.paths["/github/pulls/{number}/comments"]?.post?.operationId).toBe("github.pull.comment")
    expect(spec.paths["/github/pulls/{number}/checkout"]?.post?.operationId).toBe("github.pull.checkout")
    expect(spec.paths["/github/pulls/{number}/close"]?.post?.operationId).toBe("github.pull.close")
    expect(spec.paths["/github/pulls/{number}/reopen"]?.post?.operationId).toBe("github.pull.reopen")
    expect(spec.paths["/github/pulls/{number}/merge"]?.post?.operationId).toBe("github.pull.merge")
  })

  it.live(
    "rejects invalid pull request inputs before invoking GitHub",
    () =>
      Effect.gen(function* () {
        const directory = (request: HttpClientRequest.HttpClientRequest) =>
          HttpClientRequest.setHeader(request, "x-jyycode-directory", process.cwd())
        const json = (path: string, method: "POST" | "PATCH", body: unknown) =>
          HttpClientRequest.make(method)(path).pipe(
            directory,
            HttpClientRequest.bodyJson(body),
            Effect.flatMap(HttpClient.execute),
          )

        const responses = [
          yield* HttpClientRequest.get("/github/pulls?state=pending").pipe(directory, HttpClient.execute),
          yield* HttpClientRequest.get("/github/pulls/0").pipe(directory, HttpClient.execute),
          yield* HttpClientRequest.get("/github/pulls/-1").pipe(directory, HttpClient.execute),
          yield* json("/github/pulls", "POST", {
            head: "feature",
            base: "main",
            title: "   ",
            body: "body",
          }),
          yield* json("/github/pulls/1", "PATCH", { title: "title", body: "\t" }),
          yield* json("/github/pulls/1/comments", "POST", { body: "\n" }),
          yield* json("/github/pulls/1/merge", "POST", { method: "fast-forward" }),
        ]

        expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400, 400])
      }),
    20_000,
  )

  test("maps GitHub failures to stable public errors", () => {
    expect(toHttpError(new GitHub.GitHubError({ reason: "missing-gh", message: "missing" }))).toBeInstanceOf(
      GitHubDependencyError,
    )
    expect(toHttpError(new GitHub.GitHubError({ reason: "not-authenticated", message: "auth" }))).toBeInstanceOf(
      GitHubDependencyError,
    )
    expect(toHttpError(new GitHub.GitHubError({ reason: "not-github-repo", message: "repo" }))).toBeInstanceOf(
      GitHubRepositoryError,
    )
    expect(toHttpError(new GitHub.GitHubError({ reason: "conflict", message: "conflict" }))).toBeInstanceOf(
      GitHubRepositoryError,
    )
    expect(toHttpError(new GitHub.GitHubError({ reason: "command-failed", message: "failed" }))).toBeInstanceOf(
      GitHubCommandError,
    )
    expect(toHttpError(new GitHub.GitHubError({ reason: "invalid-response", message: "invalid" }))).toBeInstanceOf(
      GitHubCommandError,
    )
  })
})
