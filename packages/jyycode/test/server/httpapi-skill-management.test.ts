import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Global } from "@jyycode-ai/core/global"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import fs from "fs/promises"
import path from "path"

const context = Context.empty() as Context.Context<unknown>
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)
const it = testEffect(testStateLayer)

type TestHandler = ReturnType<typeof HttpApiApp.webHandler>
const handlerScoped = Effect.acquireRelease(
  Effect.sync(() => HttpApiApp.webHandler()),
  (handler) => Effect.promise(() => handler.dispose()).pipe(Effect.ignore),
)

const request = Effect.fnUntraced(function* (
  handler: TestHandler,
  route: string,
  directory: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers)
  headers.set("x-jyycode-directory", directory)
  return yield* Effect.promise(() =>
    Promise.resolve(handler.handler(new Request(`http://localhost${route}`, { ...init, headers }), context)),
  )
})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

describe.serial("Skill management HttpApi", () => {
  it.instance("returns the global management context and Skill capabilities", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const handler = yield* handlerScoped
      const managementContext = yield* request(handler, GlobalPaths.managementContext, test.directory)
      const skills = yield* request(handler, `${InstancePaths.skill}?scope=global`, test.directory)

      expect(managementContext.status).toBe(200)
      expect(yield* json(managementContext)).toEqual({ directory: Global.Path.home })
      expect(skills.status).toBe(200)
      expect(yield* json<Array<Record<string, unknown>>>(skills)).toContainEqual(
        expect.objectContaining({
          name: "customize-jyycode",
          origin: "built_in",
          editable: false,
          deletable: false,
          revision: expect.any(String),
          content: expect.any(String),
        }),
      )
    }),
  )

  it.instance("creates, updates, rejects stale content, and deletes a managed Skill", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const handler = yield* handlerScoped
      const name = `api-${path.basename(test.directory)}`
      const target = path.join(Global.Path.home, ".jyycode", "skills", name)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(target, { recursive: true, force: true })))

      const createdResponse = yield* request(handler, InstancePaths.skill, test.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description: "API Skill", content: "# Created\n" }),
      })
      expect(createdResponse.status).toBe(200)
      const created = yield* json<{ revision: string; content: string }>(createdResponse)

      const content = `---\nname: ${name}\ndescription: API Skill\n---\n\n# Updated\n`
      const updatedResponse = yield* request(handler, `/skill/${encodeURIComponent(name)}`, test.directory, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, revision: created.revision }),
      })
      expect(updatedResponse.status).toBe(200)
      const updated = yield* json<{ revision: string; content: string }>(updatedResponse)
      expect(updated.content).toBe(content)
      expect(updated.revision).not.toBe(created.revision)

      const stale = yield* request(handler, `/skill/${encodeURIComponent(name)}`, test.directory, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, revision: created.revision }),
      })
      expect(stale.status).toBe(409)

      const removed = yield* request(handler, `/skill/${encodeURIComponent(name)}`, test.directory, {
        method: "DELETE",
      })
      expect(removed.status).toBe(200)
      expect(yield* json(removed)).toBe(true)
    }),
  )

  it.instance("maps invalid, protected, and missing Skill mutations to typed statuses", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const handler = yield* handlerScoped
      const invalid = yield* request(handler, InstancePaths.skill, test.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "expected", content: "---\nname: different\n---\n" }),
      })
      const protectedResponse = yield* request(handler, "/skill/customize-jyycode", test.directory, {
        method: "DELETE",
      })
      const missing = yield* request(handler, "/skill/missing-skill", test.directory, { method: "DELETE" })

      expect(invalid.status).toBe(400)
      expect(protectedResponse.status).toBe(403)
      expect(missing.status).toBe(404)
    }),
  )

  it.instance("adds and removes global path and URL sources", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const handler = yield* handlerScoped
      const configFile = path.join(Global.Path.config, "jyycode.jsonc")
      const before = yield* Effect.promise(() => fs.readFile(configFile, "utf8").catch(() => undefined))
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (before === undefined) await fs.rm(configFile, { force: true })
          else await fs.writeFile(configFile, before)
        }),
      )
      yield* Effect.promise(() => fs.mkdir(Global.Path.config, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(configFile, "{}\n"))

      for (const source of [
        { type: "path", value: path.join(test.directory, "skills") },
        { type: "url", value: "https://skills.example.test/" },
      ]) {
        const added = yield* request(handler, InstancePaths.skillSource, test.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(source),
        })
        expect(added.status).toBe(200)
        expect(yield* json(added)).toBe(true)

        const removed = yield* request(handler, InstancePaths.skillSource, test.directory, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(source),
        })
        expect(removed.status).toBe(200)
        expect(yield* json(removed)).toBe(true)
      }
    }),
  )
})
