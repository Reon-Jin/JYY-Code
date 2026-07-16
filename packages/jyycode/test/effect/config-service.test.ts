import { describe, expect } from "bun:test"
import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { Global } from "@jyycode-ai/core/global"
import { Config as AppConfig } from "../../src/config/config"
import { ConfigService } from "../../src/effect/config-service"
import { TestInstance } from "../fixture/fixture"
import { it, testEffect } from "../lib/effect"
import fs from "fs/promises"
import path from "path"

class TestConfig extends ConfigService.Service<TestConfig>()("@test/ConfigService", {
  name: Config.string("NAME"),
  token: Config.string("TOKEN").pipe(Config.option),
  port: Config.number("PORT").pipe(Config.withDefault(3000)),
}) {}

const fromConfig = (input: Record<string, unknown>) =>
  TestConfig.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))))

const readConfig = TestConfig.useSync((config) => config)
const configIt = testEffect(AppConfig.defaultLayer)

describe("ConfigService", () => {
  it.effect("defaultLayer parses values from the active ConfigProvider", () =>
    Effect.gen(function* () {
      const config = yield* readConfig.pipe(
        Effect.provide(
          fromConfig({
            NAME: "kit",
            TOKEN: "secret",
            PORT: "4096",
          }),
        ),
      )

      expect(config.name).toBe("kit")
      expect(config.token).toEqual(Option.some("secret"))
      expect(config.port).toBe(4096)
    }),
  )

  it.effect("defaultLayer applies Effect Config defaults", () =>
    Effect.gen(function* () {
      const config = yield* readConfig.pipe(Effect.provide(fromConfig({ NAME: "kit" })))

      expect(config.name).toBe("kit")
      expect(config.token).toEqual(Option.none())
      expect(config.port).toBe(3000)
    }),
  )

  it.effect("layer provides an already parsed service value", () =>
    Effect.gen(function* () {
      const config = yield* readConfig.pipe(
        Effect.provide(
          TestConfig.layer({
            name: "direct",
            token: Option.some("parsed"),
            port: 9000,
          }),
        ),
      )

      expect(config).toEqual({
        name: "direct",
        token: Option.some("parsed"),
        port: 9000,
      } satisfies Context.Service.Shape<typeof TestConfig>)
    }),
  )
})

describe("global config path updates", () => {
  configIt.instance("preserves JSONC comments and unrelated configuration", () =>
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
            `{
  // keep this comment
  "mcp": {
    "browser": { "type": "local", "command": ["old"] },
    "old": { "type": "local", "command": ["remove-me"] },
    "keep": { "type": "local", "command": ["keep-me"] }
  },
  "skills": {
    "paths": ["/skills/local"],
    "urls": ["https://skills.example.test/"]
  }
}
`,
          )
        }),
        () =>
          Effect.gen(function* () {
            const config = yield* AppConfig.Service
            yield* config.updateGlobalPath(["mcp", "browser"], {
              type: "remote",
              url: "https://mcp.example.test",
              enabled: true,
            })
            yield* config.updateGlobalPath(["mcp", "old"], undefined)

            const source = yield* Effect.promise(() => fs.readFile(file, "utf8"))
            const parsed = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""))

            expect(parsed.mcp.browser).toEqual({
              type: "remote",
              url: "https://mcp.example.test",
              enabled: true,
            })
            expect(parsed.mcp.old).toBeUndefined()
            expect(parsed.mcp.keep).toEqual({ type: "local", command: ["keep-me"] })
            expect(parsed.skills).toEqual({
              paths: ["/skills/local"],
              urls: ["https://skills.example.test/"],
            })
            expect(source).toContain("// keep this comment")
          }),
        () =>
          Effect.sync(() => {
            Global.Path.config = previous
          }),
      )
    }),
  )

  configIt.instance("adds missing parents and reports unchanged values as a no-op", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDirectory = path.join(test.directory, "global-config")
      const file = path.join(configDirectory, "jyycode.jsonc")
      const previous = Global.Path.config

      yield* Effect.acquireUseRelease(
        Effect.promise(async () => {
          Global.Path.config = configDirectory
          await fs.mkdir(configDirectory, { recursive: true })
          await fs.writeFile(file, "{}\n")
        }),
        () =>
          Effect.gen(function* () {
            const config = yield* AppConfig.Service
            const value = {
              type: "remote" as const,
              url: "https://mcp.example.test",
              enabled: false,
            }
            const added = yield* config.updateGlobalPath(["mcp", "browser"], value)
            const beforeNoop = yield* Effect.promise(() => fs.readFile(file, "utf8"))
            const unchanged = yield* config.updateGlobalPath(["mcp", "browser"], value)
            const afterNoop = yield* Effect.promise(() => fs.readFile(file, "utf8"))

            expect(added.changed).toBe(true)
            expect(added.info.mcp?.browser).toEqual(value)
            expect(unchanged.changed).toBe(false)
            expect(afterNoop).toBe(beforeNoop)
          }),
        () =>
          Effect.sync(() => {
            Global.Path.config = previous
          }),
      )
    }),
  )

  configIt.instance("applies nested deletion to JSON files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDirectory = path.join(test.directory, "global-config")
      const file = path.join(configDirectory, "jyycode.json")
      const previous = Global.Path.config

      yield* Effect.acquireUseRelease(
        Effect.promise(async () => {
          Global.Path.config = configDirectory
          await fs.mkdir(configDirectory, { recursive: true })
          await fs.writeFile(
            file,
            JSON.stringify({
              mcp: {
                remove: { type: "local", command: ["remove"] },
                keep: { type: "local", command: ["keep"] },
              },
            }),
          )
        }),
        () =>
          Effect.gen(function* () {
            const config = yield* AppConfig.Service
            const result = yield* config.updateGlobalPath(["mcp", "remove"], undefined)
            const parsed = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))

            expect(result.changed).toBe(true)
            expect(parsed.mcp.remove).toBeUndefined()
            expect(parsed.mcp.keep).toEqual({ type: "local", command: ["keep"] })
          }),
        () =>
          Effect.sync(() => {
            Global.Path.config = previous
          }),
      )
    }),
  )

  configIt.instance("validates an update before replacing the original file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDirectory = path.join(test.directory, "global-config")
      const file = path.join(configDirectory, "jyycode.jsonc")
      const previous = Global.Path.config
      const original = `{
  // original remains intact
  "mcp": {
    "browser": { "type": "local", "command": ["browser"] }
  }
}
`

      yield* Effect.acquireUseRelease(
        Effect.promise(async () => {
          Global.Path.config = configDirectory
          await fs.mkdir(configDirectory, { recursive: true })
          await fs.writeFile(file, original)
        }),
        () =>
          Effect.gen(function* () {
            const config = yield* AppConfig.Service
            const exit = yield* Effect.exit(config.updateGlobalPath(["mcp", "browser"], { type: "remote" }))

            expect(exit._tag).toBe("Failure")
            expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(original)
          }),
        () =>
          Effect.sync(() => {
            Global.Path.config = previous
          }),
      )
    }),
  )
})
