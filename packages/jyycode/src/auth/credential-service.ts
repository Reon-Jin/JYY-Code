import { CredentialRef } from "@jyycode-ai/core/credential"
import { Context, Effect, Layer, Schema } from "effect"
import { Auth } from "."

export class Missing extends Schema.TaggedErrorClass<Missing>()("CredentialMissing", {
  ref: CredentialRef,
}) {}

export interface Interface {
  /** Resolve only at the provider execution boundary. */
  readonly resolve: (ref: CredentialRef) => Effect.Effect<string, Missing | Auth.AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Credential") {}

export const layer: Layer.Layer<Service, never, Auth.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const resolve = Effect.fn("Credential.resolve")(function* (ref: CredentialRef) {
      const info = yield* auth.get(ref.providerID)
      if (!info || Auth.reference(ref.providerID, info).credentialID !== ref.credentialID || info.type !== ref.kind) {
        return yield* new Missing({ ref })
      }
      if (info.type === "api") return info.key
      if (info.type === "oauth") return info.access
      return info.token
    })

    return Service.of({ resolve })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Auth.defaultLayer))

export * as Credential from "./credential-service"
