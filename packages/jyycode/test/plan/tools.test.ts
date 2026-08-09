import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import { Bus } from "../../src/bus"
import { EffectBridge } from "../../src/effect/bridge"
import {
  childWorkspaceFor,
  childLaunchParts,
  childTaskBrief,
  MERGE_APPLY_DESCRIPTION,
  MERGE_APPLY_INPUT_SCHEMA,
  PLAN_TOOL_IDS,
} from "../../src/plan/tools"
import { modelFacingPlanToolName } from "../../src/plan/tools"
import { RuntimeEvent } from "../../src/plan/runtime-event"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const it = testEffect(Layer.mergeAll(Bus.layer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

describe("plan runtime event bridge", () => {
  it.effect("builds the same isolated workspace manager for cleanup-capable tools", () =>
    Effect.sync(() => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-tools-project-"))
      const session = { projectID: "global", directory: root }
      const projectInfo = {
        id: "global",
        worktree: root,
        vcs: undefined,
      } as never

      expect(
        childWorkspaceFor({
          session,
          projectInfo,
          bridge: {} as EffectBridge.Shape,
        }),
      ).toBeDefined()

      fs.rmSync(root, { recursive: true, force: true })
    }),
  )

  it.effect("defines the compact main-agent Merge.apply contract", () =>
    Effect.sync(() => {
      expect(PLAN_TOOL_IDS.has("Merge.apply")).toBe(true)
      expect(modelFacingPlanToolName("Merge.apply")).toBe("Merge_apply")
      expect(MERGE_APPLY_DESCRIPTION).toContain("task_id")
      expect(MERGE_APPLY_DESCRIPTION).toContain("resolutions")
      expect(MERGE_APPLY_INPUT_SCHEMA).toEqual(
        expect.objectContaining({
          type: "object",
          additionalProperties: false,
          required: ["task_id"],
          properties: expect.objectContaining({
            task_id: expect.objectContaining({ pattern: "^s[1-9]\\d*_t[1-9]\\d*$" }),
            paths: expect.objectContaining({ type: "array" }),
            resolutions: expect.objectContaining({ type: "array" }),
          }),
        }),
      )
    }),
  )

  it.effect("shows only Instructions and the current Task goal in the child launch message", () =>
    Effect.sync(() => {
      const brief = childTaskBrief({
        run_id: "run__ses_root__s1_t1",
        task_title: "Write the notes",
        goal: "write the notes",
        done_criteria: "notes.md exists",
        workspace_root: "/workspace",
        output_path: "/workspace/notes.md",
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
      expect(brief).toContain("## Working Directory")
      expect(brief).toContain("/workspace")
      expect(brief).toContain("隔离副本")
      expect(brief).not.toContain("与主 Agent 一致")
      expect(brief).not.toContain("task_instructions")
      expect(brief).not.toContain("output_path")
      expect(brief).not.toContain("step_context")
      expect(brief).not.toContain("step_directory")
    }),
  )

  it.effect("shows review feedback directly in a retried child task", () =>
    Effect.sync(() => {
      const brief = childTaskBrief({
        run_id: "run__ses_root__s1_t1",
        task_title: "Write the notes",
        goal: "write the notes",
        done_criteria: "notes.md exists",
        workspace_root: "/workspace",
        output_path: "/workspace/notes.md",
        previous_feedback: {
          review_feedback: "在文件末尾追加 abc",
          issues: ["当前文件内容仍然只有 123"],
        },
        step_context: {
          plan_goal: "Document the API",
          step_id: "s1",
          step_title: "API analysis",
          step_goal: "Create reliable API documentation",
          step_done_criteria: "Docs cover every endpoint",
        },
        report_format: "Report(...)",
        step_directory: [],
      })

      expect(brief).toContain("审核打回后的重试")
      expect(brief).toContain("在文件末尾追加 abc")
      expect(brief).toContain("不要等待额外的“打回事件”")
      expect(brief).toContain("当前文件内容仍然只有 123")
    }),
  )

  it.effect("keeps the first child prompt visible while isolating dispatch metadata", () =>
    Effect.sync(() => {
      const parts = childLaunchParts(
        {
          run_id: "run__ses_root__s1_t1",
          task_title: "Write the notes",
          goal: "write the notes",
          done_criteria: "notes.md exists",
          workspace_root: "/workspace",
          output_path: "/workspace/notes.md",
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
      expect(parts[0]?.text).toContain("## Role Instructions")
      expect(parts[0]?.text).toContain("Use a careful implementation.")
      expect(parts[1]?.text).toContain("隔离副本")
      expect(parts[1]?.text).not.toContain("与主 Agent 一致")
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
