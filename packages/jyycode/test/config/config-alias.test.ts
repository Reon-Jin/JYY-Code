import { expect } from "bun:test"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { testEffect } from "../lib/effect"

const it = testEffect(Config.defaultLayer)

it.instance(
  "accepts plural aliases for common config keys",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.use.get()
      expect(cfg.provider?.openai?.options?.apiKey).toBe("test-key")
      expect(cfg.permission?.["*"]).toBe("allow")
      expect(cfg.plugin).toEqual(["local-plugin"])
    }),
  {
    config: {
      providers: {
        openai: {
          options: {
            apiKey: "test-key",
          },
        },
      },
      permissions: {
        "*": "allow",
      },
      plugins: ["local-plugin"],
    } as unknown as Partial<Config.Info>,
  },
)
