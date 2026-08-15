import { Schema } from "effect"

/**
 * A durable, value-free pointer to a credential. Secret material must never
 * be placed in this value or in a serialized config/session/API object.
 */
export class CredentialRef extends Schema.Class<CredentialRef>("CredentialRef")({
  providerID: Schema.String,
  credentialID: Schema.String,
  kind: Schema.Literals(["api", "oauth", "wellknown"]),
}) {}

export type Kind = CredentialRef["kind"]

export * as Credential from "./credential"
