import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import { Bus } from "../../src/bus"
import { EffectBridge } from "../../src/effect/bridge"
import { childLaunchParts, childTaskBrief } from "../../src/plan/tools"
import { RuntimeEvent } from "../../src/plan/runtime-event"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Bus.layer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

describe("plan runtime event bridge", () => {
  it.effect("shows only Instructions and the current Task goal in the child launch message", () =>
    Effect.sync(() => {
      const brief = childTaskBrief({
        run_id: "run__ses_root__s1_t1",
        task_title: "Write the notes",
        goal: "write the notes",
        done_criteria: "notes.md exists",
        output_path: "notes.md",
        task_instructions: "Read src/api.ts and document every public endpoint.",
        step_context: {
          plan_goal: "Document the API",
          step_id: "s1",
          step_title: "API analysis",
          step_goal: "Create reliable API documentation",
          step_done_criteria: "Docs cover every endpoint",
        },
        report_format: "Report(...)",
        step_directory: [
          { task_id: "s1_t1", title: "Data model", status: "running", has_agent: true, is_self: true },
          { task_id: "s1_t2", title: "API", status: "pending", has_agent: false, is_self: false },
        ],
      })

      expect(brief).toContain("## Instructions")
      expect(brief).toContain("Read src/api.ts and document every public endpoint.")
      expect(brief).toContain("## Current Task Goal")
      expect(brief).toContain("write the notes")
      expect(brief).not.toContain("task_instructions")
      expect(brief).not.toContain("output_path")
      expect(brief).not.toContain("step_context")
      expect(brief).not.toContain("step_directory")
    })
  )

  it.effect("keeps the first child prompt visible while isolating dispatch metadata", () =>
    Effect.sync(() => {
      const parts = childLaunchParts(
        {
          run_id: "run__ses_root__s1_t1",
          task_title: "Write the notes",
          goal: "write the notes",
          done_criteria: "notes.md exists",
          output_path: "notes.md",
          task_instructions: "Read src/api.ts.",
          step_context: {
            plan_goal: "Document the API",
            step_id: "s1",
            step_title: "API analysis",
            step_goal: "Create reliable API documentation",
            step_done_criteria: "Docs cover every endpoint",
          },
          report_format: "Report(...)",
          step_directory: [],
        },
        {
          id: "worker",
          name: "Worker",
          description: "Worker",
          prompt: "Use a careful implementation.",
          avatar: "bot",
        },
      )

      expect(parts[0]?.text).toContain("Read src/api.ts.")
      expect(parts[0]?.text).toContain("write the notes")
      expect(parts[0]?.synthetic).toBeUndefined()
      expect(parts[1]?.synthetic).toBe(true)
    }),
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
