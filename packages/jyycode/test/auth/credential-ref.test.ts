import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CredentialRef } from "@jyycode-ai/core/credential"
import { Auth } from "../../src/auth"
import { Credential } from "../../src/auth/credential-service"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, Credential.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("CredentialRef", () => {
  it.live("resolves the latest credential without exposing secret fields in the ref", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const credentials = yield* Credential.Service

        const initial = { type: "api" as const, key: "first-secret" }
        yield* auth.set("openai", initial)
        const ref = Auth.reference("openai", initial)

        expect(ref).toEqual({ providerID: "openai", credentialID: "openai:api", kind: "api" })
        expect(JSON.stringify(ref)).not.toContain("first-secret")
        expect(JSON.stringify(yield* auth.allPublic())).not.toContain("first-secret")
        expect(yield* credentials.resolve(ref)).toBe("first-secret")

        yield* auth.set("openai", { type: "api", key: "rotated-secret" })
        expect(yield* credentials.resolve(ref)).toBe("rotated-secret")

        yield* auth.remove("openai")
        const result = yield* credentials.resolve(ref).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.effect("decodes only value-free credential references", () => {
    const ref = CredentialRef.make({ providerID: "anthropic", credentialID: "anthropic:api", kind: "api" })
    expect(Schema.is(CredentialRef)(ref)).toBe(true)
    expect(JSON.stringify(ref)).not.toMatch(/key|token|access|refresh/i)
    return Effect.void
  })
})
