import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Flag } from "@jyycode-ai/core/flag/flag"
import { createJyycodeClient } from "@jyycode-ai/sdk/v2"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
  ),
)

const original = {
  password: Flag.JYYCODE_SERVER_PASSWORD,
  username: Flag.JYYCODE_SERVER_USERNAME,
}

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function serverFetch() {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      Server.Default().app.fetch(input instanceof Request ? input : new Request(input, init)),
    { preconnect: globalThis.fetch.preconnect },
  ) satisfies typeof globalThis.fetch
}

function client(directory: string) {
  return createJyycodeClient({
    baseUrl: "http://desktop.test",
    directory,
    headers: { Authorization: authorization("desktop", "desktop-secret") },
    fetch: serverFetch(),
  })
}

afterEach(async () => {
  Flag.JYYCODE_SERVER_PASSWORD = original.password
  Flag.JYYCODE_SERVER_USERNAME = original.username
  await disposeAllInstances()
  await resetDatabase()
})

describe("desktop shared-backend contract", () => {
  it.live(
    "authenticates, prompts over SSE, and reloads a single-Agent Session",
    Effect.gen(function* () {
      Flag.JYYCODE_SERVER_USERNAME = "desktop"
      Flag.JYYCODE_SERVER_PASSWORD = "desktop-secret"
      const directory = yield* tmpdirScoped({
        git: true,
        config: { formatter: false, lsp: false },
      })
      const sdk = client(directory)

      const health = yield* Effect.promise(() => sdk.global.health())
      expect(health.response.status).toBe(200)
      expect(health.data).toMatchObject({ healthy: true })

      const project = yield* Effect.promise(() => sdk.project.current({ directory }))
      expect(project.response.status).toBe(200)
      expect(project.data?.worktree).toBe(directory)

      const controller = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
      const stream = yield* Effect.promise(() => sdk.global.event({ signal: controller.signal }))
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => void (await stream.stream.return?.(undefined))).pipe(Effect.ignore),
      )
      const connected = yield* Deferred.make<void>()
      const observed = yield* Deferred.make<Set<string>>()
      yield* Effect.promise(async () => {
        const types = new Set<string>()
        for await (const event of stream.stream) {
          const type = event.payload.type
          if (type === "server.connected") Deferred.doneUnsafe(connected, Effect.void)
          if (event.directory === directory && (type === "message.updated" || type === "message.part.updated")) {
            types.add(type)
            if (types.size === 2) {
              Deferred.doneUnsafe(observed, Effect.succeed(types))
              return
            }
          }
        }
      }).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(Deferred.await(connected), "desktop SSE did not connect", "5 seconds")

      const created = yield* Effect.promise(() =>
        sdk.session.create({ directory, title: "Desktop contract", multiAgent: false }),
      )
      expect(created.response.status).toBe(200)
      const sessionID = created.data?.id
      if (!sessionID) return yield* Effect.fail(new Error("desktop session was not created"))

      const prompt = yield* Effect.promise(() =>
        sdk.session.promptAsync({
          directory,
          sessionID,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "desktop contract prompt" }],
        }),
      )
      expect(prompt.response.status).toBe(204)
      expect(
        yield* awaitWithTimeout(Deferred.await(observed), "desktop message events were not delivered", "5 seconds"),
      ).toEqual(new Set(["message.updated", "message.part.updated"]))

      const reloaded = yield* Effect.promise(() => client(directory).session.messages({ directory, sessionID }))
      expect(reloaded.response.status).toBe(200)
      expect(JSON.stringify(reloaded.data)).toContain("desktop contract prompt")
    }),
    30_000,
  )
})
