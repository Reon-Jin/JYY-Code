import { Schema } from "effect"

export const Mode = Schema.Literals(["direct", "deferred"])
export type Mode = Schema.Schema.Type<typeof Mode>

export const Info = Schema.Record(Schema.String, Mode).annotate({
  identifier: "ToolDisclosureConfig",
  description:
    "Per-tool prompt disclosure overrides. Direct tools are sent to the model; deferred tools use tool_search and tool_exec.",
})
export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigToolDisclosure from "./tool-disclosure"
