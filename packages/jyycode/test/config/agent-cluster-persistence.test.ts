import { expect, test } from "bun:test"
import { Global } from "@jyycode-ai/core/global"
import { Config } from "@/config/config"
import { AgentClusterSchema } from "@/agent-cluster/schema"
import { Effect } from "effect"
import { Schema } from "effect"
import fs from "fs/promises"
import path from "path"
import { testEffect } from "../lib/effect"

const it = testEffect(Config.defaultLayer)
const globalConfigFiles = ["jyycode.jsonc", "jyycode.json", "config.json"].map((file) =>
  path.join(Global.Path.config, file),
)

const cleanGlobalConfig = Effect.promise(() =>
  Promise.all(globalConfigFiles.map((file) => fs.rm(file, { force: true }))),
)

const withCleanGlobalConfig = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    cleanGlobalConfig,
    () => effect,
    () => cleanGlobalConfig,
  )

test("models session-scoped tasks with provenance and interrupted terminal state", () => {
  const task = Schema.decodeUnknownSync(AgentClusterSchema.TaskRecord)({
    id: "task-build-ui",
    sessionID: "ses_root" as any,
    originMessageID: "msg_plan" as any,
    role: "coder",
    title: "Build UI",
    prompt: "Implement the panel",
    complexity: "complex",
    model: "test/model",
    status: "interrupted",
    step: 2,
    dependencies: ["task-research"],
    reviewRound: 0,
    acceptanceCriteria: [],
    artifactPaths: [],
    reviewIssues: [],
    createdAt: 1,
    updatedAt: 1,
  } as any)

  expect(task.sessionID).toBe("ses_root" as any)
  expect(task.originMessageID).toBe("msg_plan" as any)
  expect(task.status).toBe("interrupted")
  expect("runID" in task).toBe(false)
})

it.instance(
  "persists cluster role models globally for a fresh session",
  withCleanGlobalConfig(
    Effect.gen(function* () {
      const config = yield* Config.Service
      const models = {
        planner_model: "test/planner",
        simple_model: "test/simple",
        complex_model: "test/complex",
        visual_model: "test/visual",
      }

      const updated = yield* config.updateGlobal({ agent_cluster: models })
      expect(updated.changed).toBe(true)

      const persisted = JSON.parse(yield* Effect.promise(() => fs.readFile(globalConfigFiles[0], "utf8")))
      expect(persisted.agent_cluster).toEqual(models)

      const freshSession = yield* config.get()
      expect(freshSession.agent_cluster).toEqual(models)
    }),
  ),
)
