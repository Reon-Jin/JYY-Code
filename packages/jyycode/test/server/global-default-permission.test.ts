import { describe, expect } from "bun:test"
import { Global } from "@jyycode-ai/core/global"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { createJyycodeClient } from "@jyycode-ai/sdk/v2"
import { Context, Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
  ),
)
const context = Context.empty() as Context.Context<unknown>

const handlerScoped = Effect.acquireRelease(
  Effect.sync(() => HttpApiApp.webHandler()),
  (handler) => Effect.promise(() => handler.dispose()).pipe(Effect.ignore),
)

describe("global default permission API", () => {
  it.live("reports custom rules and safely replaces or removes the global default", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const configDirectory = path.join(root, "config")
      const configFile = path.join(configDirectory, "jyycode.jsonc")
      const previous = Global.Path.config
      const original = `{
  // keep this comment
  "model": "test/model",
  "permission": { "*": "ask", "bash": "deny" }
}
`

      yield* Effect.acquireUseRelease(
        Effect.promise(async () => {
          Global.Path.config = configDirectory
          await fs.mkdir(configDirectory, { recursive: true })
          await fs.writeFile(configFile, original)
        }),
        () =>
          Effect.gen(function* () {
            const handler = yield* handlerScoped
            const fetch = Object.assign(
              async (input: RequestInfo | URL, init?: RequestInit) =>
                handler.handler(input instanceof Request ? input : new Request(input, init), context),
              { preconnect: globalThis.fetch.preconnect },
            ) satisfies typeof globalThis.fetch
            const client = createJyycodeClient({ baseUrl: "http://localhost", fetch })

            const custom = yield* Effect.promise(() => client.global.defaultPermission.get())
            expect(custom.data).toEqual({ mode: "custom" })

            yield* Effect.promise(() =>
              client.global.defaultPermission.update({ mode: "request" }, { throwOnError: true }),
            )
            const requested = yield* Effect.promise(() => fs.readFile(configFile, "utf8"))
            expect(requested).toContain('// keep this comment')
            expect(requested).toContain('"model": "test/model"')
            expect(requested).toContain('"*": "ask"')
            expect(requested).not.toContain('"bash"')

            yield* Effect.promise(() =>
              client.global.defaultPermission.update({ mode: "auto" }, { throwOnError: true }),
            )
            const automatic = yield* Effect.promise(() => client.global.defaultPermission.get())
            expect(automatic.data).toEqual({ mode: "auto" })
            const config = yield* Effect.promise(() => client.global.config.get())
            expect(config.data?.permission).toBeUndefined()
          }),
        () =>
          Effect.sync(() => {
            Global.Path.config = previous
          }),
      )
    }),
  )
})
