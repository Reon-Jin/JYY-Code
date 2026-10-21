import { describe, expect, spyOn } from "bun:test"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Global } from "@jyycode-ai/core/global"
import { Context, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as lifecycle from "../../src/server/global-lifecycle"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { defaultGeneralProfile } from "../../src/agent/subagent-profile"
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

describe("global subagent timeout setting", () => {
  it.live("persists the timeout and preserves profiles without disposing running instances", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const configDirectory = path.join(root, "config")
      const configFile = path.join(configDirectory, "jyycode.jsonc")
      const previous = Global.Path.config
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          await fs.mkdir(configDirectory, { recursive: true })
          await fs.writeFile(
            configFile,
            `// keep user comments\n${JSON.stringify({
              shell: "cmd",
              subagents: { profiles: [defaultGeneralProfile] },
            })}`,
          )
          Global.Path.config = configDirectory
        }),
        () =>
          Effect.sync(() => {
            Global.Path.config = previous
          }),
      )
      const dispose = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(lifecycle, "disposeAllInstancesAndEmitGlobalDisposed").mockImplementation(() => Effect.void),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )
      const handler = yield* Effect.acquireRelease(
        Effect.sync(() => HttpApiApp.createWebHandler()),
        (value) => Effect.promise(() => value.dispose()).pipe(Effect.ignore),
      )
      const context = Context.empty() as Context.Context<unknown>
      const request = (method: string, body?: unknown) =>
        Effect.promise(() =>
          Promise.resolve(
            handler.handler(
              new Request("http://localhost/global/config", {
                method,
                headers: { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
              }),
              context,
            ),
          ),
        )

      expect((yield* request("PATCH", { subagents: { timeout_ms: 1_200_000 } })).status).toBe(200)
      expect(dispose).not.toHaveBeenCalled()
      const response = yield* request("GET")
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        shell: "cmd",
        subagents: { timeout_ms: 1_200_000, profiles: [defaultGeneralProfile] },
      })
      expect(yield* Effect.promise(() => fs.readFile(configFile, "utf8"))).toContain("// keep user comments")
      // Other global edits retain their existing reload behavior.
      expect((yield* request("PATCH", { shell: "pwsh" })).status).toBe(200)
      expect(dispose).toHaveBeenCalledTimes(1)
    }),
  )
})
