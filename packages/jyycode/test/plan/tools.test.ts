import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import { Bus } from "../../src/bus"
import { EffectBridge } from "../../src/effect/bridge"
import { childTaskBrief } from "../../src/plan/tools"
import { RuntimeEvent } from "../../src/plan/runtime-event"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Bus.layer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

describe("plan runtime event bridge", () => {
  it.effect("formats child task briefs as visible Markdown instead of hidden HTML", () =>
    Effect.sync(() => {
      const brief = childTaskBrief({
        run_id: "run__ses_root__s1_t1",
        goal: "write the notes",
        done_criteria: "notes.md exists",
        output_path: "notes.md",
        report_format: "Report(...)",
      })

      expect(brief).toContain("## 主 Agent 派发的任务简报")
      expect(brief).toContain('\"output_path\": \"notes.md\"')
      expect(brief).toContain("```json")
      expect(brief).not.toContain("<plan-task-brief>")
    })
  )

  it.instance("publishes plan updates with the captured instance context", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const bridge = yield* EffectBridge.make()
      const received = yield* Deferred.make<{ type: string; session_id: string; revision?: number }>()
      yield* bus.subscribeCallback(RuntimeEvent, (event) => {
        Deferred.doneUnsafe(received, Effect.succeed(event.properties))
      })

      bridge.fork(
        bus.publish(RuntimeEvent, {
          seq: 1,
          type: "plan.updated",
          session_id: "ses_root",
          revision: 2,
          at: new Date().toISOString(),
          payload: {},
        }),
      )

      const event = yield* Deferred.await(received).pipe(Effect.timeout("2 seconds"))
      expect(event).toMatchObject({ type: "plan.updated", session_id: "ses_root", revision: 2 })
    }),
  )
})
