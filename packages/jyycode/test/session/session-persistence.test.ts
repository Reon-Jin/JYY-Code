import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Flag } from "@jyycode-ai/core/flag/flag"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { Database } from "@/storage/db"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { reopenDatabase } from "../fixture/db"
import { provideTestInstance, tmpdir } from "../fixture/fixture"

const fixture = path.join(import.meta.dir, "fixture", "session-persistence-process.ts")

const sessionLayer = Session.layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(SyncEvent.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
  Layer.provide(BackgroundJob.defaultLayer),
)

const runInInstance = <A, E>(directory: string, effect: Effect.Effect<A, E, Session.Service>) =>
  provideTestInstance({
    directory,
    fn: (ctx) =>
      Effect.runPromise(
        effect.pipe(Effect.provideService(InstanceRef, ctx), Effect.provide(sessionLayer), Effect.scoped),
      ),
  })

function childOutput(result: { stdout: Uint8Array; stderr: Uint8Array }) {
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

describe("session persistence", () => {
  test.serial(
    "reloads a session and user message after closing SQLite",
    async () => {
      await using dir = await tmpdir({ git: true })
      const dbPath = path.join(dir.path, "session-persistence.db")
      const previousEnv = process.env.JYYCODE_DB
      const previousFlag = Flag.JYYCODE_DB

      process.env.JYYCODE_DB = dbPath
      Flag.JYYCODE_DB = dbPath
      Database.close()

      try {
        const created = await runInInstance(
          dir.path,
          Session.Service.use((session) =>
            Effect.gen(function* () {
              const created = yield* session.create({ title: "restart persistence" })
              yield* session.updateMessage({
                id: MessageID.ascending(),
                sessionID: created.id,
                role: "user",
                time: { created: Date.now() },
                agent: "user",
                model: { providerID: "test", modelID: "test" },
                tools: {},
                mode: "",
              } as unknown as MessageV2.Info)
              return created
            }),
          ),
        )

        await reopenDatabase()

        const { reloaded, messages } = await runInInstance(
          dir.path,
          Session.Service.use((session) =>
            Effect.all({
              reloaded: session.get(created.id),
              messages: session.messages({ sessionID: created.id }),
            }),
          ),
        )

        expect(reloaded.id).toBe(created.id)
        expect(messages.some((message) => message.info.role === "user")).toBe(true)
      } finally {
        Database.close()
        if (previousEnv === undefined) delete process.env.JYYCODE_DB
        else process.env.JYYCODE_DB = previousEnv
        Flag.JYYCODE_DB = previousFlag
        Database.Client()
      }
    },
    { timeout: 30000 },
  )

  test("persists across independent processes", async () => {
    await using dir = await tmpdir({ git: true })
    const dbPath = path.join(dir.path, "subprocess-persistence.db")
    const env = { ...process.env, JYYCODE_DB: dbPath }

    const created = childOutput(
      await Bun.$`bun ${fixture} create ${dir.path}`
        .env(env)
        .cwd(path.join(import.meta.dir, "../.."))
        .quiet(),
    )
    const sessionID = /^SESSION_ID=(.+)$/m.exec(created.stdout)?.[1]?.trim()
    expect(sessionID, created.stderr || created.stdout).toBeDefined()

    const loaded = childOutput(
      await Bun.$`bun ${fixture} load ${dir.path} ${sessionID!}`
        .env(env)
        .cwd(path.join(import.meta.dir, "../.."))
        .quiet(),
    )
    expect(loaded.stdout).toContain("SESSION_TITLE=subprocess persistence")
  }, 30000)
})
