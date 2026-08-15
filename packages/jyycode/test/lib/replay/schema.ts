import { Schema } from "effect"

const JsonValue = Schema.Unknown

export const ReplayExpectedSchema = Schema.Struct({
  requestEnvelopes: Schema.Array(JsonValue),
  messages: Schema.Array(JsonValue),
  events: Schema.Array(JsonValue),
  files: Schema.Array(JsonValue),
})

export const ReplayFixtureSchema = Schema.Struct({
  version: Schema.Number,
  workspaceSeed: JsonValue,
  sessionInput: JsonValue,
  modelReplies: Schema.Array(JsonValue),
  expected: ReplayExpectedSchema,
  terminalStatus: JsonValue,
})

export type ReplayExpected = typeof ReplayExpectedSchema.Type
export type ReplayFixture = typeof ReplayFixtureSchema.Type

export const decodeReplayFixture = Schema.decodeUnknownSync(ReplayFixtureSchema)
