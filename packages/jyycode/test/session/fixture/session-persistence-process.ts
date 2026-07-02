import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, type SessionID } from "@/session/schema"
import { initProjectors } from "@/server/projectors"
import { Database } from "@/storage/db"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { Effect, Layer } from "effect"
import { provideTestInstance } from "../../fixture/fixture"

const [mode, directory, sessionID] = process.argv.slice(2)
if (!mode || !directory) throw new Error("usage: session-persistence-process <create|load> <directory> [sessionID]")
initProjectors()

const sessionLayer = Session.layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(SyncEvent.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
  Layer.provide(BackgroundJob.defaultLayer),
)

const run = <A, E>(effect: Effect.Effect<A, E, Session.Service>) =>
  provideTestInstance({
    directory,
    fn: (ctx) =>
      Effect.runPromise(
        effect.pipe(Effect.provideService(InstanceRef, ctx), Effect.provide(sessionLayer), Effect.scoped),
      ),
  })

try {
  if (mode === "create") {
    const created = await run(
      Session.Service.use((session) =>
        Effect.gen(function* () {
          const created = yield* session.create({ title: "subprocess persistence" })
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
    console.log(`SESSION_ID=${created.id}`)
  } else if (mode === "load" && sessionID) {
    const loaded = await run(Session.Service.use((session) => session.get(sessionID as SessionID)))
    console.log(`SESSION_TITLE=${loaded.title}`)
  } else {
    throw new Error("load mode requires a session ID")
  }
} finally {
  Database.close()
}
