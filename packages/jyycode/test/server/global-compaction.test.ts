import { describe, expect } from "bun:test"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Global } from "@jyycode-ai/core/global"
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

const defaults = {
  auto: true,
  prune: true,
  tailTurns: 2,
  triggerRatio: 0.92,
  microCompact: true,
  microCompactMaxChars: 8000,
  reactiveCompact: true,
}

describe("global compaction API", () => {
  it.live("validates and updates only the global compaction path", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const configDirectory = path.join(root, "config")
      const configFile = path.join(configDirectory, "jyycode.jsonc")
      const previous = Global.Path.config
      const original = `{
  // keep unrelated settings
  "shell": "powershell",
  "permission": { "*": "ask" },
  "mcp": { "keep": { "type": "local", "command": ["keep"], "enabled": false } }
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
            const request = (method: string, body?: unknown) =>
              Effect.promise(() =>
                Promise.resolve(
                  handler.handler(
                    new Request("http://localhost/global/compaction", {
                      method,
                      headers: body === undefined ? undefined : { "content-type": "application/json" },
                      body: body === undefined ? undefined : JSON.stringify(body),
                    }),
                    context,
                  ),
                ),
              )
            const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

            const initial = yield* request("GET")
            expect(initial.status).toBe(200)
            expect(yield* json(initial)).toEqual(defaults)

            const update = {
              auto: false,
              prune: false,
              tailTurns: 12,
              preserveRecentTokens: 32000,
              reservedTokens: 16000,
              triggerRatio: 0.75,
              microCompact: false,
              microCompactMaxChars: 24000,
              reactiveCompact: false,
            }
            const updated = yield* request("PUT", update)
            expect(updated.status).toBe(200)
            expect(yield* json(updated)).toEqual(update)

            const persisted = JSON.parse((yield* Effect.promise(() => fs.readFile(configFile, "utf8"))).replace(/\/\/.*$/gm, ""))
            expect(persisted.compaction).toEqual({
              auto: false,
              prune: false,
              tail_turns: 12,
              preserve_recent_tokens: 32000,
              reserved: 16000,
              trigger_ratio: 0.75,
              micro_compact: false,
              micro_compact_max_chars: 24000,
              reactive_compact: false,
            })
            expect(persisted).toMatchObject({
              shell: "powershell",
              permission: { "*": "ask" },
              mcp: { keep: expect.any(Object) },
            })

            for (const invalid of [
              { ...update, tailTurns: -1 },
              { ...update, tailTurns: 1.5 },
              { ...update, triggerRatio: 0.49 },
              { ...update, triggerRatio: 0.99 },
              { ...update, preserveRecentTokens: -1 },
              { ...update, reservedTokens: 131073 },
              { ...update, microCompactMaxChars: 100001 },
            ]) {
              expect((yield* request("PUT", invalid)).status).toBe(400)
            }

            const removed = yield* request("DELETE")
            expect(removed.status).toBe(200)
            expect(yield* json(removed)).toEqual(defaults)
            const afterDelete = yield* Effect.promise(() => fs.readFile(configFile, "utf8"))
            expect(afterDelete).not.toContain('"compaction"')
            expect(afterDelete).toContain('"shell": "powershell"')
            expect(afterDelete).toContain('"mcp"')
            expect(afterDelete).toContain('"permission"')
          }),
        () => Effect.sync(() => (Global.Path.config = previous)),
      )
    }),
  )
})
