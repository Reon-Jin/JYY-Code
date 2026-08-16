import { Schema } from "effect"
import { withStatics } from "./schema"

/**
 * A durable, value-free pointer to a credential. Secret material must never
 * be placed in this value or in a serialized config/session/API object.
 *
 * This is intentionally a plain struct schema rather than `Schema.Class`.
 * Public HTTP responses are JSON-round-tripped before being encoded, so a
 * class-identity encoder would reject the resulting plain object.
 */
const schema = Schema.Struct({
  providerID: Schema.String,
  credentialID: Schema.String,
  kind: Schema.Literals(["api", "oauth", "wellknown"]),
}).annotate({ identifier: "CredentialRef" })

export type Kind = CredentialRef["kind"]
type CredentialRefInput = {
  providerID: string
  credentialID: string
  kind: Kind
}

export const CredentialRef = schema.pipe(
  withStatics(() => ({
    make: (input: CredentialRefInput): CredentialRef => input as CredentialRef,
  })),
)

export type CredentialRef = Schema.Schema.Type<typeof CredentialRef>

export * as Credential from "./credential"
