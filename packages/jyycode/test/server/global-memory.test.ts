import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Flag } from "@jyycode-ai/core/flag/flag"
import { Effect, Layer } from "effect"
import { Memory } from "../../src/memory/memory"
import { Server } from "../../src/server/server"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const originalPassword = Flag.JYYCODE_SERVER_PASSWORD
const originalEnvPassword = process.env.JYYCODE_SERVER_PASSWORD
afterEach(() => {
  Flag.JYYCODE_SERVER_PASSWORD = originalPassword
  if (originalEnvPassword === undefined) delete process.env.JYYCODE_SERVER_PASSWORD
  else process.env.JYYCODE_SERVER_PASSWORD = originalEnvPassword
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
  ),
)
describe("authenticated global memory API", () => {
  it.live("supports safe list, exact mutations, compaction, task clearing, and export without leaking paths", () =>
    Effect.gen(function* () {
      Flag.JYYCODE_SERVER_PASSWORD = "memory-secret"
      process.env.JYYCODE_SERVER_PASSWORD = "memory-secret"
      yield* Effect.promise(() => fs.rm(Memory.DIRECTORY, { recursive: true, force: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(Memory.DIRECTORY, { recursive: true, force: true })))

      const taskSession = SessionID.make("ses_memory_api")
      yield* Effect.promise(async () => {
        await fs.mkdir(Memory.DIRECTORY, { recursive: true })
        await fs.writeFile(
          path.join(Memory.DIRECTORY, "MEMORY.json"),
          Memory.serializeStore("memory", [
            {
              scope: "memory",
              sessionID: taskSession,
              importance: 6,
              date: "20260716",
              keywords: ["设置"],
              content: "用户要求完成设置，我完成了设置。",
            },
            {
              scope: "memory",
              sessionID: SessionID.make("ses_memory_api_second"),
              importance: 7,
              date: "20260716",
              keywords: ["附件"],
              content: "用户要求支持附件，我完成了文件上传。",
            },
          ]),
        )
        await fs.writeFile(path.join(Memory.DIRECTORY, "USER.json"), Memory.serializeStore("user", []))
      })

      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
      yield* Effect.addFinalizer(() => Effect.promise(() => listener.stop()).pipe(Effect.ignore))
      const authorization = `Basic ${Buffer.from("jyycode:memory-secret").toString("base64")}`
      const request = (method: string, url: string, body?: unknown, authenticated = true) =>
        Effect.promise(() =>
          fetch(new URL(url, listener.url), {
            method,
            headers: {
              ...(authenticated ? { authorization } : {}),
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
      const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

      expect((yield* request("GET", "/global/memory?scope=user", undefined, false)).status).toBe(401)

      const create = yield* request("POST", "/global/memory/user", {
        importance: 8,
        keywords: ["语言"],
        content: "用户偏好简体中文。",
      })
      expect(create.status).toBe(200)
      const created = yield* json<{ id: string; scope: string }>(create)
      expect(created).toMatchObject({ scope: "user" })
      expect(created.id).toMatch(/^usr_/)

      const listed = yield* request("GET", "/global/memory?scope=user&query=中文&limit=10")
      expect(listed.status).toBe(200)
      const page = yield* json<{ entries: Array<{ id: string; content: string }>; total: number }>(listed)
      expect(page).toMatchObject({ total: 1, entries: [{ id: created.id, content: "用户偏好简体中文。" }] })

      const updated = yield* request("PUT", `/global/memory/user/${created.id}`, {
        importance: 9,
        keywords: ["语言"],
        content: "用户偏好 English。",
      })
      expect(updated.status).toBe(200)

      const conflict = yield* request("PUT", "/global/memory/task/not-a-user-id?sessionID=ses_memory_api", {
        importance: 5,
        keywords: ["任务"],
        content: "用户要求更新任务，我完成了更新。",
      })
      expect(conflict.status).toBe(400)

      const taskList = yield* request("GET", "/global/memory?scope=task")
      const taskPage = yield* json<{ entries: Array<{ id: string }> }>(taskList)
      expect(taskPage.entries).toHaveLength(2)
      expect((yield* request("GET", "/global/memory/export?scope=task")).status).toBe(200)
      expect((yield* request("POST", "/global/memory/task/compact")).status).toBe(200)

      const compact = yield* request("POST", "/global/memory/user/compact")
      expect(compact.status).toBe(200)

      const exported = yield* request("GET", "/global/memory/export?scope=user")
      expect(exported.status).toBe(200)
      const exportBody = yield* json<{ schemaVersion: number; entries: unknown[] }>(exported)
      expect(exportBody.schemaVersion).toBe(3)
      expect(Memory.parseStore("user", JSON.stringify(exportBody)).entries).toHaveLength(1)

      const sensitive = yield* request("PUT", `/global/memory/user/${created.id}`, {
        importance: 9,
        keywords: ["密钥"],
        content: "api_key=sk-secret",
      })
      expect(sensitive.status).toBe(400)
      const safeError = JSON.stringify(yield* json(sensitive))
      expect(safeError).not.toContain(Memory.DIRECTORY)
      expect(safeError).not.toContain("audit.jsonl")
      expect(safeError).not.toContain("stack")

      const stale = yield* request("DELETE", `/global/memory/task/${taskPage.entries[0]!.id}?sessionID=ses_memory_api`)
      expect(stale.status).toBe(200)
      expect((yield* request("DELETE", `/global/memory/task/${taskPage.entries[0]!.id}?sessionID=ses_memory_api`)).status).toBe(404)

      const clear = yield* request("POST", "/global/memory/task/clear")
      expect(clear.status).toBe(200)
      expect(yield* json(clear)).toEqual({ removed: 1 })

      expect((yield* request("DELETE", `/global/memory/user/${created.id}`)).status).toBe(200)
      expect((yield* request("GET", "/global/memory?scope=invalid")).status).toBe(400)

      const allBodies = JSON.stringify([page, exportBody])
      expect(allBodies).not.toContain("D:\\")
      expect(allBodies).not.toContain(Memory.DIRECTORY)
      expect(allBodies).not.toContain("audit.jsonl")
    }),
  )
})
