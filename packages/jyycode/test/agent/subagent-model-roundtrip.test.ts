import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Global } from "@jyycode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import { Config as AppConfig } from "../../src/config/config"
import { resolveProfiles } from "../../src/agent/subagent-profile"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppConfig.defaultLayer)

describe("subagent model roundtrip", () => {
  it.instance("keeps an explicit role model that matches the main agent model", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDirectory = path.join(test.directory, "global-config")
      const file = path.join(configDirectory, "jyycode.jsonc")
      const previous = Global.Path.config

      yield* Effect.acquireUseRelease(
        Effect.promise(async () => {
          Global.Path.config = configDirectory
          await fs.mkdir(configDirectory, { recursive: true })
          await fs.writeFile(
            file,
            JSON.stringify(
              {
                model: "deepseek/deepseek-v4-pro",
                subagents: {
                  profiles: [
                    {
                      id: "general",
                      name: "General",
                      description: "General-purpose agent for delegated execution.",
                      prompt: "",
                      avatar: "bot",
                      enabled: true,
                    },
                  ],
                },
              },
              null,
              2,
            ),
          )
        }),
        () =>
          Effect.gen(function* () {
            const config = yield* AppConfig.Service
            const current = yield* config.getGlobal()
            const resolved = resolveProfiles(current.subagents?.profiles)
            // Simulate the panel save: pick the same model as the main agent
            const next = resolved.map((profile) =>
              profile.id === "general" ? { ...profile, model: "deepseek/deepseek-v4-pro" } : profile,
            )
            yield* config.updateGlobal({ subagents: { profiles: next } })

            const source = yield* Effect.promise(() => fs.readFile(file, "utf8"))
            expect(source).toContain("deepseek/deepseek-v4-pro")

            const reread = yield* config.getGlobal()
            const reresolved = resolveProfiles(reread.subagents?.profiles)
            expect(reresolved.find((profile) => profile.id === "general")?.model).toBe("deepseek/deepseek-v4-pro")
          }),
        () =>
          Effect.sync(() => {
            Global.Path.config = previous
          }),
      )
    }),
  )
})
