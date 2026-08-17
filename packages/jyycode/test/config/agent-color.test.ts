import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Config.defaultLayer, AgentSvc.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.instance(
  "agent color parsed from project config",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.use.get()
      expect(cfg.agent?.["build"]?.color).toBe("#FFA500")
    }),
  {
    git: true,
    config: {
      agent: {
        build: { color: "#FFA500" },
      },
    },
  },
)

it.instance(
  "Agent.get includes color from config",
  () =>
    Effect.gen(function* () {
      const build = yield* AgentSvc.use.get("build")
      expect(build?.color).toBe("accent")
    }),
  {
    git: true,
    config: {
      agent: {
        build: { color: "accent" },
      },
    },
  },
)
