import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Auth } from "../../src/auth"
import * as Log from "@jyycode-ai/core/util/log"
import { Effect } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

function app() {
  return Server.Default().app
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

function serialized(value: unknown) {
  return JSON.stringify(value)
}

const it = testEffect(Auth.defaultLayer)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("credential redaction", () => {
  it.live(
    "does not serialize inline provider secrets through config or provider views",
    Effect.gen(function* () {
      const secret = "sk-redaction-test-secret"
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            openai: {
              options: {
                apiKey: secret,
                accessToken: "access-redaction-test",
                refreshToken: "refresh-redaction-test",
              },
            },
          },
        },
      })

      const configResponse = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config", { headers: { "x-jyycode-directory": tmp.path } })),
      )
      const configBody = yield* Effect.promise(() => configResponse.json())

      const providersResponse = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config/providers", { headers: { "x-jyycode-directory": tmp.path } })),
      )
      const providersBody = yield* Effect.promise(() => providersResponse.json())

      expect(serialized(configBody)).not.toContain(secret)
      expect(serialized(configBody)).not.toMatch(/access-redaction-test|refresh-redaction-test/)
      expect(serialized(providersBody)).not.toContain(secret)
      expect(serialized(providersBody)).not.toMatch(/access-redaction-test|refresh-redaction-test/)
      expect(serialized(providersBody)).not.toMatch(/"(apiKey|accessToken|refreshToken|key|token)"\s*:/i)

      const updateResponse = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: { "content-type": "application/json", "x-jyycode-directory": tmp.path },
            body: JSON.stringify({
              formatter: false,
              lsp: false,
              provider: { openai: { options: { apiKey: "sk-explicit-migration" } } },
            }),
          }),
        ),
      )
      expect(updateResponse.status).toBe(200)
      const persisted = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).json())
      expect(serialized(persisted)).not.toContain("sk-explicit-migration")
      const stored = yield* Auth.Service.use((auth) => auth.get("openai")).pipe(Effect.orDie)
      expect(stored).toMatchObject({ type: "api", key: "sk-explicit-migration" })
      yield* Auth.Service.use((auth) => auth.remove("openai")).pipe(Effect.orDie)
    }),
  )
})
