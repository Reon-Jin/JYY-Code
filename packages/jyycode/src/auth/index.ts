import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@jyycode-ai/core/schema"
import { Global } from "@jyycode-ai/core/global"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CredentialRef } from "@jyycode-ai/core/credential"

export const OAUTH_DUMMY_KEY = "jyycode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export const PublicInfo = Schema.Struct({
  providerID: Schema.String,
  credentialID: Schema.String,
  kind: Schema.Literals(["api", "oauth", "wellknown"]),
}).annotate({ identifier: "CredentialReference" })
export type PublicInfo = Schema.Schema.Type<typeof PublicInfo>

export function reference(providerID: string, info: Pick<Info, "type">): CredentialRef {
  return CredentialRef.make({
    providerID,
    credentialID: `${providerID}:${info.type}`,
    kind: info.type,
  })
}

export function toPublicInfo(providerID: string, info: Info): PublicInfo {
  const ref = reference(providerID, info)
  return {
    providerID: ref.providerID,
    credentialID: ref.credentialID,
    kind: ref.kind,
  }
}

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly getPublic: (providerID: string) => Effect.Effect<PublicInfo | undefined, AuthError>
  readonly allPublic: () => Effect.Effect<Record<string, PublicInfo>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.JYYCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.JYYCODE_AUTH_CONTENT)
        } catch {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const getPublic = Effect.fn("Auth.getPublic")(function* (providerID: string) {
      const info = yield* get(providerID)
      return info ? toPublicInfo(providerID, info) : undefined
    })

    const allPublic = Effect.fn("Auth.allPublic")(function* () {
      const data = yield* all()
      return Object.fromEntries(
        Object.entries(data).map(([providerID, info]) => [
          providerID,
          toPublicInfo(providerID, Schema.decodeUnknownSync(Info)(info)),
        ]),
      )
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, getPublic, allPublic, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."
