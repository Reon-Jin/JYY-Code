import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import * as Log from "@jyycode-ai/core/util/log"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Server } from "../../src/server/server"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { InstanceStore } from "../../src/project/instance-store"
import { resetDatabase } from "../fixture/db"
import { TestInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffectShared } from "../lib/effect"

void Log.init({ print: false })

const config = {
  formatter: false,
  lsp: false,
  provider: {
    test: { npm: "@ai-sdk/openai-compatible", options: { apiKey: "test-key" }, models: { test: { name: "Test" } } },
  },
} as const
const it = testEffectShared(
  Layer.mergeAll(
    testInstanceStoreLayer,
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.promise(() => resetDatabase()),
        () => Effect.promise(() => resetDatabase()),
      ),
    ),
  ),
)

describe("child control HttpApi", () => {
  for (const action of ["abort", "interrupt-prompt", "terminate"] as const) {
    for (const owner of ["root", "child"] as const) {
      it.instance(
        `${action} controls a child running in the ${owner} instance from its isolated directory`,
        Effect.gen(function* () {
          const root = yield* TestInstance
          const directory = yield* tmpdirScoped({ config })
          const sessions = yield* Session.Service
          const runs = yield* SessionRunState.Service
          const statuses = yield* SessionStatus.Service
          const store = yield* InstanceStore.Service
          const parent = yield* sessions.create({ title: "Parent" })
          const child = yield* sessions.create({ parentID: parent.id, title: "Child", directory })
          const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }
          const ownerDirectory = owner === "root" ? root.directory : child.directory
          // A real running child has already initialized its prompt dependencies.
          // Use that path here so the steering deadline measures persistence,
          // rather than cold agent/skill/plugin initialization on the CI host.
          const message = yield* store.provide(
            { directory: ownerDirectory },
            (yield* SessionPrompt.Service).prompt({
              sessionID: child.id,
              agent: "build",
              model,
              noReply: true,
              parts: [],
            }),
          )
          const ready = yield* Deferred.make<void>()
          const runner = yield* store
            .provide(
              { directory: ownerDirectory },
              runs.ensureRunning(
                child.id,
                Effect.succeed(message),
                statuses
                  .set(child.id, { type: "busy" })
                  .pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never)),
              ),
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(ready)
          yield* pollWithTimeout(
            store
              .provide({ directory: ownerDirectory }, statuses.get(child.id))
              .pipe(Effect.map((status) => (status.type === "busy" ? true : undefined))),
            "child runner never became busy",
            "2 seconds",
          )
          expect(yield* runs.directory(child.id)).toBe(ownerDirectory)
          expect(child.directory).not.toBe(root.directory)

          if (action === "interrupt-prompt") {
            // Disposing a test-owned handler must leave the default server's
            // background scope alive, regardless of cross-file test order.
            yield* Effect.acquireUseRelease(
              Effect.sync(() => HttpApiApp.createWebHandler()),
              (handler) =>
                Effect.promise(() =>
                  handler.handler(new Request("http://localhost/global/health"), HttpApiApp.context),
                ).pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200)))),
              (handler) => Effect.promise(() => handler.dispose()),
            )
          }

          const response = yield* Effect.promise(async () =>
            Server.Default().app.request(`/session/${child.id}/${action}`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-jyycode-directory": child.directory },
              ...(action === "interrupt-prompt"
                ? {
                    body: JSON.stringify({
                      agent: "build",
                      model,
                      noReply: true,
                      parts: [{ type: "text", text: "New instructions" }],
                    }),
                  }
                : {}),
            }),
          )
          expect(response.status).toBe(action === "abort" ? 200 : 204)
          yield* Fiber.join(runner).pipe(Effect.timeout("2 seconds"))
          expect(yield* runs.directory(child.id)).toBeUndefined()
          expect((yield* store.provide({ directory: ownerDirectory }, statuses.get(child.id))).type).toBe("idle")
          if (action === "terminate") {
            expect((yield* sessions.get(child.id)).time.archived).toBeDefined()
          } else if (action === "interrupt-prompt") {
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const messages = yield* sessions.messages({ sessionID: child.id })
                return messages.some((message) =>
                  message.parts.some((part) => part.type === "text" && part.text === "New instructions"),
                )
                  ? true
                  : undefined
              }),
              "steering message was not persisted",
              "3 seconds",
            )
          }
        }),
        { config },
        30000,
      )
    }
  }
})
