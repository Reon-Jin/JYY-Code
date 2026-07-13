import { describe, expect } from "bun:test"
import { AppProcess } from "@jyycode-ai/core/process"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Bus } from "@/bus"
import { Git } from "@/git"
import { GitHub } from "@/project/github"
import { testEffect } from "../lib/effect"

type SpawnResult = string | { code: number; stdout?: string; stderr?: string }
type SpawnHandler = (command: string, args: readonly string[]) => SpawnResult

const encoder = new TextEncoder()

function mockSpawner(handler: SpawnHandler) {
  const spawner = ChildProcessSpawner.make((command) => {
    const standard = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(standard?.command ?? "", standard?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function testLayer(handler: SpawnHandler, events?: Array<{ type: string; properties: unknown }>) {
  const appProcess = AppProcess.layer.pipe(Layer.provide(mockSpawner(handler)))
  const git = Git.layer.pipe(Layer.provide(appProcess))
  const bus = events
    ? Layer.mock(Bus.Service)({
        publish: (definition, properties) =>
          Effect.sync(() => {
            events.push({ type: definition.type, properties })
          }),
      })
    : Bus.layer
  return GitHub.layer.pipe(Layer.provide(appProcess), Layer.provide(git), Layer.provide(bus))
}

const availableRepository = JSON.stringify({
  nameWithOwner: "acme/widgets",
  url: "https://github.com/acme/widgets",
  defaultBranchRef: { name: "main" },
})

describe("GitHub availability", () => {
  testEffect(
    testLayer((_command, args) => {
      if (args[0] === "repo") return availableRepository
      return ""
    }),
  ).instance("detects an authenticated GitHub repository", () =>
    Effect.gen(function* () {
      const github = yield* GitHub.Service

      expect(yield* github.availability()).toEqual({
        available: true,
        repository: {
          nameWithOwner: "acme/widgets",
          url: "https://github.com/acme/widgets",
          defaultBranch: "main",
        },
      })
    }),
  )

  const failures = [
    {
      name: "reports a missing gh executable",
      handler: (_command: string, args: readonly string[]): SpawnResult =>
        args[0] === "--version" ? { code: 127, stderr: "gh: command not found" } : "",
      reason: "missing-gh",
    },
    {
      name: "reports an unauthenticated gh session",
      handler: (_command: string, args: readonly string[]): SpawnResult =>
        args[0] === "auth" ? { code: 1, stderr: "not logged into github.com" } : "",
      reason: "not-authenticated",
    },
    {
      name: "reports a non-GitHub repository",
      handler: (_command: string, args: readonly string[]): SpawnResult =>
        args[0] === "repo" ? { code: 1, stderr: "no remotes found" } : "",
      reason: "not-github-repo",
    },
    {
      name: "reports an unexpected gh failure",
      handler: (_command: string, args: readonly string[]): SpawnResult =>
        args[0] === "--version" ? { code: 2, stderr: "unexpected failure" } : "",
      reason: "command-failed",
    },
  ] as const

  for (const scenario of failures) {
    testEffect(testLayer(scenario.handler)).instance(scenario.name, () =>
      Effect.gen(function* () {
        const github = yield* GitHub.Service
        const result = yield* github.availability()

        expect(result).toMatchObject({ available: false, reason: scenario.reason, message: expect.any(String) })
      }),
    )
  }
})

const summaryFields = "number,title,state,isDraft,headRefName,baseRefName,author,updatedAt,url,reviewDecision"
const detailFields = `${summaryFields},body,mergeable,comments,commits,statusCheckRollup`
const summary = {
  number: 7,
  title: "Improve widgets",
  state: "OPEN",
  isDraft: false,
  headRefName: "feature/widgets",
  baseRefName: "main",
  author: { login: "octocat", name: "Octo Cat" },
  updatedAt: "2026-07-13T04:00:00Z",
  url: "https://github.com/acme/widgets/pull/7",
  reviewDecision: "APPROVED",
} as const

describe("GitHub pull request reads", () => {
  testEffect(
    testLayer((_command, args) => {
      if (args[1] === "list") return JSON.stringify([summary])
      if (args[1] === "view") {
        return JSON.stringify({
          ...summary,
          body: "Ready for review",
          mergeable: "MERGEABLE",
          comments: [
            {
              id: "IC_1",
              body: "Looks good",
              author: { login: "reviewer" },
              createdAt: "2026-07-13T04:01:00Z",
              url: "https://github.com/acme/widgets/pull/7#issuecomment-1",
            },
          ],
          commits: [
            {
              oid: "abc123",
              messageHeadline: "Improve widgets",
              authoredDate: "2026-07-13T03:00:00Z",
              authors: [{ login: "octocat", name: "Octo Cat" }],
            },
          ],
          statusCheckRollup: [
            {
              name: "test",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              detailsUrl: "https://github.com/acme/widgets/actions/runs/1",
            },
          ],
        })
      }
      if (args[1] === "diff") return "diff --git a/a.txt b/a.txt\n+hello\n"
      return { code: 1, stderr: `unexpected gh args: ${args.join(" ")}` }
    }),
  ).instance("maps list, detail, checks, and diff responses", () =>
    Effect.gen(function* () {
      const github = yield* GitHub.Service

      expect(yield* github.listPullRequests({ state: "all" })).toEqual([summary])
      expect(yield* github.getPullRequest(7)).toEqual({
        ...summary,
        body: "Ready for review",
        mergeable: "MERGEABLE",
        comments: [
          {
            id: "IC_1",
            body: "Looks good",
            author: { login: "reviewer" },
            createdAt: "2026-07-13T04:01:00Z",
            url: "https://github.com/acme/widgets/pull/7#issuecomment-1",
          },
        ],
        commits: [
          {
            oid: "abc123",
            messageHeadline: "Improve widgets",
            authoredDate: "2026-07-13T03:00:00Z",
            authors: [{ login: "octocat", name: "Octo Cat" }],
          },
        ],
        checks: [
          {
            name: "test",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: "https://github.com/acme/widgets/actions/runs/1",
          },
        ],
      })
      expect(yield* github.getPullRequestDiff(7)).toBe("diff --git a/a.txt b/a.txt\n+hello\n")
    }),
  )

  testEffect(testLayer(() => JSON.stringify({ unexpected: true }))).instance("rejects invalid gh JSON responses", () =>
    Effect.gen(function* () {
      const github = yield* GitHub.Service
      const error = yield* Effect.flip(github.listPullRequests({ state: "all" }))

      expect(error.reason).toBe("invalid-response")
    }),
  )

  testEffect(
    testLayer((_command, args) => {
      if (args[1] === "list") {
        expect(args).toEqual(["pr", "list", "--state", "all", "--limit", "100", "--json", summaryFields])
        return "[]"
      }
      if (args[1] === "view") {
        expect(args).toEqual(["pr", "view", "7", "--json", detailFields])
        return JSON.stringify({
          ...summary,
          body: "",
          mergeable: "UNKNOWN",
          comments: [],
          commits: [],
          statusCheckRollup: [],
        })
      }
      expect(args).toEqual(["pr", "diff", "7"])
      return "diff"
    }),
  ).instance("uses exact argv for pull request reads", () =>
    Effect.gen(function* () {
      const github = yield* GitHub.Service
      yield* github.listPullRequests({ state: "all" })
      yield* github.getPullRequest(7)
      yield* github.getPullRequestDiff(7)
    }),
  )
})

describe("GitHub pull request mutations", () => {
  const calls: string[][] = []
  const events: Array<{ type: string; properties: unknown }> = []
  testEffect(
    testLayer((command, args) => {
      if (command === "git") return "feature/widgets\n"
      calls.push([...args])
      if (args[1] === "create") return "https://github.com/acme/widgets/pull/7\n"
      return ""
    }, events),
  ).instance("passes content as argv and publishes checkout branch updates", () =>
    Effect.gen(function* () {
      calls.length = 0
      events.length = 0
      const github = yield* GitHub.Service

      expect(
        yield* github.createPullRequest({
          head: "feature/widgets",
          base: "main",
          title: "Improve widgets",
          body: "Body with spaces\nand newlines",
          draft: true,
        }),
      ).toEqual({ number: 7, url: "https://github.com/acme/widgets/pull/7" })
      yield* github.editPullRequest({ number: 7, title: "Edited widgets", body: "Edited body" })
      yield* github.commentOnPullRequest({ number: 7, body: "A review comment" })
      yield* github.checkoutPullRequest(7)
      yield* github.closePullRequest(7)
      yield* github.reopenPullRequest(7)
      yield* github.mergePullRequest({ number: 7, method: "squash", deleteBranch: true })

      expect(calls).toEqual([
        [
          "pr",
          "create",
          "--head",
          "feature/widgets",
          "--base",
          "main",
          "--title",
          "Improve widgets",
          "--body",
          "Body with spaces\nand newlines",
          "--draft",
        ],
        ["pr", "edit", "7", "--title", "Edited widgets", "--body", "Edited body"],
        ["pr", "comment", "7", "--body", "A review comment"],
        ["pr", "checkout", "7"],
        ["pr", "close", "7"],
        ["pr", "reopen", "7"],
        ["pr", "merge", "7", "--squash", "--delete-branch"],
      ])
      expect(events).toEqual([{ type: "vcs.branch.updated", properties: { branch: "feature/widgets" } }])
    }),
  )
})
