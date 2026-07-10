import { expect } from "bun:test"
import { Global } from "@jyycode-ai/core/global"
import { Config } from "@/config/config"
import { Effect } from "effect"
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
