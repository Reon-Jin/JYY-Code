import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@jyycode-ai/core/flag/flag"
import { describe, expect } from "bun:test"
import { Config, Context, Effect, FileSystem, Layer, Path } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { Global } from "@jyycode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import * as Socket from "effect/unstable/socket/Socket"
import { WorkspaceID } from "../../src/control-plane/schema"
import { ControlPaths } from "../../src/server/routes/instance/httpapi/groups/control"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { PermissionID } from "../../src/permission/schema"
import { ProjectID } from "../../src/project/schema"
import { Git } from "../../src/git"
import { QuestionID } from "../../src/question/schema"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { disposeMiddleware } from "../../src/server/routes/instance/httpapi/lifecycle"
import { HEADER as FenceHeader } from "../../src/server/shared/fence"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Flip the experimental workspaces flag so SyncEvent.run actually writes to
// EventSequenceTable (the source of truth the fence middleware reads). Reset
// the database around the test so per-instance state does not leak between
// runs. resetDatabase() already calls disposeAllInstances(), so we don't
// repeat it.
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const originalWorkspaces = Flag.JYYCODE_EXPERIMENTAL_WORKSPACES
    Flag.JYYCODE_EXPERIMENTAL_WORKSPACES = true
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.JYYCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
        await resetDatabase()
      }),
    )
  }),
)

// Mount the production HttpApi route tree on a real Node HTTP server bound to
// 127.0.0.1:0 and a fetch-based HttpClient that prepends the server URL. This
// keeps the test wired directly through the same route layer production uses.
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true, middleware: disposeMiddleware },
)

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiServerLayer, Git.defaultLayer))
const handlerContext = Context.empty() as Context.Context<unknown>

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-jyycode-directory", dir)
const directoryQuery = (dir: string) => HttpClientRequest.setUrlParam("directory", dir)

const git = Effect.fn("HttpApiInstanceTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
})

describe("instance HttpApi", () => {
  it.live("serves the OpenAPI document", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/doc")

      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("application/json")
      expect(yield* response.json).toMatchObject({
        openapi: expect.any(String),
        info: expect.any(Object),
        paths: expect.objectContaining({
          "/global/health": expect.any(Object),
          "/session": expect.any(Object),
        }),
      })
    }),
  )

  it.live("emits a sync fence header for fixed-workspace mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.JYYCODE_WORKSPACE_ID
      Flag.JYYCODE_WORKSPACE_ID = WorkspaceID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.JYYCODE_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.post(SessionPaths.create).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ title: "fenced" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(response.status).toBe(200)
      expect(JSON.parse(response.headers[FenceHeader] ?? "{}")).not.toEqual({})
    }),
  )

  it.live("does not emit sync fence headers for fixed-workspace reads or no-op mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.JYYCODE_WORKSPACE_ID
      Flag.JYYCODE_WORKSPACE_ID = WorkspaceID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.JYYCODE_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const read = yield* HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute)
      const log = yield* HttpClientRequest.post(ControlPaths.log).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ service: "fence-test", level: "info", message: "noop" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(read.status).toBe(200)
      expect(read.headers[FenceHeader]).toBeUndefined()
      expect(log.status).toBe(200)
      expect(log.headers[FenceHeader]).toBeUndefined()
    }),
  )

  it.live("rejects malformed permission and question request ids", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-jyycode-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const [permission, questionReply, questionReject] = yield* Effect.all(
        [
          request("/permission/invalid-permission-id/reply", {
            method: "POST",
            body: JSON.stringify({ reply: "once" }),
          }),
          request("/question/invalid-question-id/reply", {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request("/question/invalid-question-id/reject", { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(permission.status).toBe(400)
      expect(questionReply.status).toBe(400)
      expect(questionReject.status).toBe(400)
    }),
  )

  it.live("returns typed not found bodies for missing permission and question requests", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-jyycode-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const permissionID = PermissionID.ascending()
      const questionReplyID = QuestionID.ascending()
      const questionRejectID = QuestionID.ascending()
      const [permission, questionReply, questionReject] = yield* Effect.all(
        [
          request(`/permission/${permissionID}/reply`, {
            method: "POST",
            body: JSON.stringify({ reply: "once" }),
          }),
          request(`/question/${questionReplyID}/reply`, {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request(`/question/${questionRejectID}/reject`, { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(permission.status).toBe(404)
      expect(yield* Effect.promise(() => permission.json())).toEqual({
        _tag: "PermissionNotFoundError",
        requestID: permissionID,
        message: `Permission request not found: ${permissionID}`,
      })
      expect(questionReply.status).toBe(404)
      expect(yield* Effect.promise(() => questionReply.json())).toEqual({
        _tag: "QuestionNotFoundError",
        requestID: questionReplyID,
        message: `Question request not found: ${questionReplyID}`,
      })
      expect(questionReject.status).toBe(404)
      expect(yield* Effect.promise(() => questionReject.json())).toEqual({
        _tag: "QuestionNotFoundError",
        requestID: questionRejectID,
        message: `Question request not found: ${questionRejectID}`,
      })
    }),
  )

  it.live("returns typed not found bodies for missing projects", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const projectID = ProjectID.make("project_missing")
      const response = yield* Effect.promise(() =>
        HttpApiApp.webHandler().handler(
          new Request(`http://localhost/project/${projectID}`, {
            method: "PATCH",
            headers: { "x-jyycode-directory": dir, "content-type": "application/json" },
            body: JSON.stringify({ name: "Missing" }),
          }),
          handlerContext,
        ),
      )

      expect(response.status).toBe(404)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        _tag: "ProjectNotFoundError",
        projectID,
        message: `Project not found: ${projectID}`,
      })
    }),
  )

  it.live("serves path and VCS read endpoints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(dir, "changed.txt"), "hello")

      const [paths, vcs, diff] = yield* Effect.all(
        [
          HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcs).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcsDiff).pipe(
            HttpClientRequest.setUrlParam("mode", "git"),
            directoryHeader(dir),
            HttpClient.execute,
          ),
        ],
        { concurrency: "unbounded" },
      )

      expect(paths.status).toBe(200)
      expect(yield* paths.json).toMatchObject({ directory: dir, worktree: dir })

      expect(vcs.status).toBe(200)
      expect(yield* vcs.json).toMatchObject({ branch: expect.any(String) })

      expect(diff.status).toBe(200)
      expect(yield* diff.json).toContainEqual(
        expect.objectContaining({ file: "changed.txt", additions: 1, status: "added" }),
      )
    }),
  )

  it.live("serves typed VCS branch and remote operations", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const remote = yield* tmpdirScoped()
      yield* git(dir, ["branch", "-M", "main"])
      yield* git(remote, ["init", "--bare"])
      yield* git(dir, ["remote", "add", "origin", remote])

      const listed = yield* HttpClientRequest.get(InstancePaths.vcsBranches).pipe(
        directoryQuery(dir),
        HttpClient.execute,
      )
      expect(listed.status).toBe(200)
      expect(yield* listed.json).toMatchObject({
        current: "main",
        branches: [expect.objectContaining({ name: "main", kind: "local", current: true })],
        remotes: [expect.objectContaining({ name: "origin" })],
      })

      const created = yield* HttpClientRequest.post(InstancePaths.vcsBranchCreate).pipe(
        directoryQuery(dir),
        HttpClientRequest.bodyJson({ name: "feature/api", checkout: true }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(created.status).toBe(200)
      expect(yield* created.json).toMatchObject({ current: "feature/api" })

      const switched = yield* HttpClientRequest.post(InstancePaths.vcsBranchSwitch).pipe(
        directoryQuery(dir),
        HttpClientRequest.bodyJson({ name: "main" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(switched.status).toBe(200)
      expect(yield* switched.json).toMatchObject({ current: "main" })

      const fetched = yield* HttpClientRequest.post(InstancePaths.vcsFetch).pipe(
        directoryQuery(dir),
        HttpClient.execute,
      )
      expect(fetched.status).toBe(200)

      const pushed = yield* HttpClientRequest.post(InstancePaths.vcsPush).pipe(
        directoryQuery(dir),
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClient.execute,
      )
      const pushedBody = yield* pushed.json
      expect(pushed.status, JSON.stringify(pushedBody)).toBe(200)
      expect(pushedBody).toMatchObject({
        current: "main",
        branches: expect.arrayContaining([expect.objectContaining({ name: "main", upstream: "origin/main" })]),
      })
    }),
  )

  it.live("returns a typed 400 error for invalid branch names", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.post(InstancePaths.vcsBranchCreate).pipe(
        directoryQuery(dir),
        HttpClientRequest.bodyJson({ name: "bad branch", checkout: true }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({
        name: "VcsOperationError",
        data: { message: "The branch name is invalid", reason: "invalid-name" },
      })
    }),
  )

  it.live("manages global subagent profiles and private role skills", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({
        git: true,
        config: {
          model: "openai/gpt-5",
          subagents: {
            profiles: [
              {
                id: "general",
                name: "General",
                description: "General delegated execution",
                prompt: "",
                avatar: "bot",
                enabled: true,
              },
            ],
          },
        },
      })
      const previousGlobalConfig = Global.Path.config
      const globalConfigDirectory = path.join(dir, "global-config")
      yield* Effect.promise(() => fs.mkdir(globalConfigDirectory, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(globalConfigDirectory, "jyycode.json"), "{}\n"))
      Global.Path.config = globalConfigDirectory
      yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.config = previousGlobalConfig)))
      const roleID = `review-${path.basename(dir)}`
      const roleRoot = path.join(Global.Path.home, ".jyycode", "role", roleID, "skills")
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(path.dirname(path.dirname(roleRoot)), { recursive: true, force: true })),
      )

      const list = yield* HttpClientRequest.get("/subagents").pipe(directoryHeader(dir), HttpClient.execute)
      expect(list.status).toBe(200)
      const initial = yield* list.json
      expect(initial).toEqual([expect.objectContaining({ id: "general", skills: [] })])
      const projectConfig = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(dir, "jyycode.json"), "utf8")))
      expect(projectConfig.model).toBe("openai/gpt-5")
      expect(projectConfig.subagents).toBeUndefined()
      const globalConfig = JSON.parse(
        yield* Effect.promise(() => fs.readFile(path.join(globalConfigDirectory, "jyycode.json"), "utf8")),
      )
      expect(globalConfig.subagents.profiles).toEqual([
        expect.objectContaining({ id: "general", name: "General", enabled: true }),
      ])

      const profiles = [
        {
          id: "general",
          name: "General",
          description: "General delegated execution",
          prompt: "",
          avatar: "bot",
          tools: ["read"],
          enabled: true,
        },
        {
          id: roleID,
          name: "Review",
          description: "Review assigned artifacts",
          prompt: "Read the private role skill first.",
          avatar: "file",
          tools: ["plugin_custom"],
          enabled: true,
        },
      ]
      const updated = yield* HttpClientRequest.put("/subagents").pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ profiles }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(updated.status).toBe(200)
      expect(yield* updated.json).toEqual([
        expect.objectContaining({ id: "general", tools: ["read"] }),
        expect.objectContaining({ id: roleID, name: "Review", tools: ["plugin_custom"], skills: [] }),
      ])

      const persisted = yield* HttpClientRequest.get("/subagents").pipe(directoryHeader(dir), HttpClient.execute)
      const persistedBody = yield* persisted.json
      expect(persisted.status, JSON.stringify(persistedBody)).toBe(200)
      expect(persistedBody).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "general", tools: ["read"] }),
          expect.objectContaining({ id: roleID, tools: ["plugin_custom"] }),
        ]),
      )

      const migratedProjectConfig = JSON.parse(
        yield* Effect.promise(() => fs.readFile(path.join(dir, "jyycode.json"), "utf8")),
      )
      expect(migratedProjectConfig.model).toBe("openai/gpt-5")
      expect(migratedProjectConfig.subagents).toBeUndefined()
      const updatedGlobalConfig = JSON.parse(
        yield* Effect.promise(() => fs.readFile(path.join(globalConfigDirectory, "jyycode.json"), "utf8")),
      )
      expect(updatedGlobalConfig.subagents.profiles).toEqual(profiles)

      const otherDir = yield* tmpdirScoped({ git: true })
      const otherList = yield* HttpClientRequest.get("/subagents").pipe(directoryHeader(otherDir), HttpClient.execute)
      expect(otherList.status).toBe(200)
      expect(yield* otherList.json).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: roleID,
            name: "Review",
            description: "Review assigned artifacts",
            prompt: "Read the private role skill first.",
            avatar: "file",
            enabled: true,
          }),
        ]),
      )

      yield* Effect.promise(() => fs.mkdir(path.join(roleRoot, "manual"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(roleRoot, "manual", "SKILL.md"),
          "---\nname: manual\ndescription: Manual role skill\n---\n\n# Manual\n",
        ),
      )

      const created = yield* HttpClientRequest.post(`/subagents/${roleID}/skills`).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ name: "notes", content: "# Notes\n" }),
        Effect.flatMap(HttpClient.execute),
      )
      const createdBody = yield* created.json
      expect(created.status, JSON.stringify(createdBody)).toBe(200)
      expect(createdBody).toEqual(expect.objectContaining({ id: `role:${roleID}:notes`, name: "notes" }))
      expect(yield* Effect.promise(() => Bun.file(path.join(roleRoot, "notes", "SKILL.md")).text())).toContain(
        "name: notes",
      )

      const afterCreate = yield* HttpClientRequest.get("/subagents").pipe(directoryHeader(dir), HttpClient.execute)
      const afterCreateBody = yield* afterCreate.json
      const role = (afterCreateBody as Array<{ id: string; skills: Array<{ name: string }> }>).find(
        (profile) => profile.id === roleID,
      )
      expect(role?.skills.map((skill) => skill.name)).toEqual(["manual", "notes"])

      const duplicate = yield* HttpClientRequest.post(`/subagents/${roleID}/skills`).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ name: "notes", content: "# Again\n" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(duplicate.status).toBe(409)

      const unsafe = yield* HttpClientRequest.post(`/subagents/${roleID}/skills`).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ name: "../escape", content: "# Unsafe\n" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(unsafe.status).toBe(400)

      const unknown = yield* HttpClientRequest.post("/subagents/missing/skills").pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ name: "notes", content: "# Missing\n" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(unknown.status).toBe(404)
    }),
  )
})
